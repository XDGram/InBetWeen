import type { AiProvider } from "../ai/provider.js";
import type { PersistenceAdapter } from "../persistence/persistence.js";
import type {
  CompleteWorkInput,
  CompleteWorkResult,
  ExternalAgentError,
  ExternalAgentErrorCode,
  ExternalAgentEventCommand,
  ExternalAgentResult,
  ExternalAgentRuntimePort,
  FailWorkInput,
  FailWorkResult,
  GetHumanInputInput,
  GetHumanInputResult,
  HumanInputRuntimeEvent,
  PublishArtifactInput,
  PublishArtifactResult,
  RegisterSessionInput,
  RegisterSessionResult,
  ReportActivityInput,
  ReportActivityResult,
  RequestDecisionInput,
  RequestDecisionResult,
  StartWorkInput,
  StartWorkResult,
} from "../shared/externalAgent.js";
import { createId, type RuntimeClock, SystemClock } from "../shared/ids.js";
import type {
  ArtifactUpdatedEvent,
  RuntimeEvent,
  UserDecision,
  UserDirectionValue,
  WorkActivityEvent,
  WorkCompletedEvent,
  WorkFailedEvent,
  WorkSession,
  WorkStartedEvent,
  AiNeedsUserEvent,
} from "../shared/types.js";
import { applyRuntimeEvent, createWorkSession } from "./stateMachine.js";

export interface WorkRuntimeOptions {
  /** Temporary legacy execution driver. External-agent operation does not require it. */
  aiProvider?: AiProvider;
  persistence: PersistenceAdapter;
  clock?: RuntimeClock;
}

export type RuntimeEventListener = (session: WorkSession, event: RuntimeEvent) => void;

const directionInstructions: Record<UserDirectionValue, string> = {
  minimal: "Use a minimal visual direction with restraint, clear hierarchy, and generous space.",
  bold: "Use a bold visual direction with strong contrast, expressive type, and confident composition.",
  ai_decide: "Choose the visual direction that best supports the task and explain it through the artifact.",
};

export class WorkRuntime implements ExternalAgentRuntimePort {
  private readonly aiProvider?: AiProvider;
  private readonly persistence: PersistenceAdapter;
  private readonly clock: RuntimeClock;
  private readonly listeners = new Map<string, Set<RuntimeEventListener>>();
  private readonly registrations = new Map<string, { sessionId: string; task: string; context?: Record<string, unknown> }>();

  constructor(options: WorkRuntimeOptions) {
    this.aiProvider = options.aiProvider;
    this.persistence = options.persistence;
    this.clock = options.clock ?? new SystemClock();
  }

  async createSession(task: string): Promise<WorkSession> {
    return this.persistNewSession({ task });
  }

  async registerSession(input: RegisterSessionInput): Promise<RegisterSessionResult> {
    const task = input.task.trim();
    if (!input.idempotencyKey.trim()) {
      return failure("validation_error", "Registration idempotencyKey is required.", input.sessionId);
    }
    if (!task) {
      return failure("validation_error", "Session task is required.", input.sessionId);
    }

    const registered = this.registrations.get(input.idempotencyKey);
    if (registered) {
      if (registered.task !== task || JSON.stringify(registered.context) !== JSON.stringify(input.context)) {
        return failure("conflict", "Registration idempotencyKey was already used with different input.", registered.sessionId);
      }
      const session = await this.persistence.getSession(registered.sessionId);
      return session
        ? { ok: true, value: { sessionId: session.id, session } }
        : failure("internal_error", "Registered session could not be loaded.", registered.sessionId, true);
    }

    if (input.sessionId && await this.persistence.getSession(input.sessionId)) {
      return failure("conflict", `Session ${input.sessionId} already exists.`, input.sessionId);
    }

    try {
      const session = await this.persistNewSession({ id: input.sessionId, task, context: input.context });
      this.registrations.set(input.idempotencyKey, { sessionId: session.id, task, context: input.context });
      return { ok: true, value: { sessionId: session.id, session } };
    } catch (error) {
      return { ok: false, error: toExternalError(error, input.sessionId) };
    }
  }

  async startWork(input: StartWorkInput): Promise<StartWorkResult>;
  /** @deprecated Provider-driven compatibility overload. Use the command form for external agents. */
  async startWork(sessionId: string): Promise<WorkSession>;
  async startWork(input: StartWorkInput | string): Promise<StartWorkResult | WorkSession> {
    if (typeof input === "string") {
      return this.startWithLegacyProvider(input);
    }

    return this.externalWrite(input, async (session, now) => {
      const event: WorkStartedEvent = {
        id: input.eventId,
        sessionId: input.sessionId,
        type: "work.started",
        createdAt: now,
      };
      const next = await this.commitEvent(session, event, input.expectedSessionUpdatedAt);
      return { sessionId: next.id, session: next, event };
    });
  }

  async reportActivity(input: ReportActivityInput): Promise<ReportActivityResult> {
    if (!input.activity.message.trim()) {
      return failure("validation_error", "Activity message is required.", input.sessionId);
    }

    return this.externalWrite(input, async (session, now) => {
      const event: WorkActivityEvent = {
        id: input.eventId,
        sessionId: input.sessionId,
        type: "work.activity",
        createdAt: now,
        activity: {
          id: createId("activity"),
          sessionId: input.sessionId,
          message: input.activity.message.trim(),
          metadata: input.activity.metadata,
          createdAt: now,
        },
      };
      const next = await this.commitEvent(session, event, input.expectedSessionUpdatedAt);
      return { sessionId: next.id, session: next, event };
    });
  }

  async publishArtifact(input: PublishArtifactInput): Promise<PublishArtifactResult> {
    if (!input.artifact.content) {
      return failure("validation_error", "Artifact content is required.", input.sessionId);
    }
    if (!Number.isInteger(input.expectedArtifactVersion) || input.expectedArtifactVersion < 0) {
      return failure("validation_error", "expectedArtifactVersion must be a non-negative integer.", input.sessionId);
    }

    return this.externalWrite(input, async (session, now) => {
      const currentVersion = session.currentArtifact?.version ?? 0;
      if (input.expectedArtifactVersion !== currentVersion) {
        throw new ExternalOperationError(
          "artifact_version_conflict",
          `Expected artifact version ${input.expectedArtifactVersion}, but current version is ${currentVersion}.`,
          true,
          { expectedArtifactVersion: input.expectedArtifactVersion, currentArtifactVersion: currentVersion },
        );
      }
      if (session.currentArtifact && input.artifactId && input.artifactId !== session.currentArtifact.id) {
        throw new ExternalOperationError(
          "artifact_version_conflict",
          `Artifact ${input.artifactId} does not match current artifact ${session.currentArtifact.id}.`,
          false,
        );
      }

      const artifact = {
        id: session.currentArtifact?.id ?? input.artifactId ?? createId("artifact"),
        sessionId: input.sessionId,
        kind: input.artifact.kind,
        version: currentVersion + 1,
        title: input.artifact.title,
        content: input.artifact.content,
        metadata: input.artifact.metadata,
        createdAt: session.currentArtifact?.createdAt ?? now,
        updatedAt: now,
      };
      const event: ArtifactUpdatedEvent = {
        id: input.eventId,
        sessionId: input.sessionId,
        type: "artifact.updated",
        createdAt: now,
        artifact,
      };
      const next = await this.commitEvent(session, event, input.expectedSessionUpdatedAt);
      return { sessionId: next.id, session: next, artifact, event };
    });
  }

  async requestDecision(input: RequestDecisionInput): Promise<RequestDecisionResult> {
    const prompt = input.prompt.trim();
    if (!prompt) {
      return failure("validation_error", "Decision prompt is required.", input.sessionId);
    }
    if (input.options?.some((option) => !option.id.trim() || !option.label.trim())) {
      return failure("validation_error", "Decision options require non-empty ids and labels.", input.sessionId);
    }
    const optionIds = input.options?.map((option) => option.id) ?? [];
    if (new Set(optionIds).size !== optionIds.length) {
      return failure("validation_error", "Decision option ids must be unique.", input.sessionId);
    }

    return this.externalWrite(input, async (session, now) => {
      const decision = {
        id: input.decisionId ?? createId("decision_request"),
        sessionId: input.sessionId,
        prompt,
        options: input.options,
        required: true as const,
        createdAt: now,
      };
      const event: AiNeedsUserEvent = {
        id: input.eventId,
        sessionId: input.sessionId,
        type: "ai.needs_user",
        createdAt: now,
        decision,
      };
      const next = await this.commitEvent(session, event, input.expectedSessionUpdatedAt);
      return { sessionId: next.id, session: next, decision, event };
    });
  }

  async getHumanInput(input: GetHumanInputInput): Promise<GetHumanInputResult> {
    const session = await this.persistence.getSession(input.sessionId);
    if (!session) {
      return failure("session_not_found", `Session ${input.sessionId} does not exist.`, input.sessionId);
    }
    if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)) {
      return failure("validation_error", "Human input limit must be an integer from 1 to 100.", input.sessionId);
    }

    let startIndex = 0;
    if (input.afterEventId) {
      const cursorIndex = session.events.findIndex((event) => event.id === input.afterEventId);
      if (cursorIndex < 0) {
        return failure("validation_error", `Event cursor ${input.afterEventId} does not exist in this session.`, input.sessionId);
      }
      startIndex = cursorIndex + 1;
    }

    const events = session.events
      .slice(startIndex)
      .filter(isHumanInputEvent)
      .slice(0, input.limit) as HumanInputRuntimeEvent[];

    return {
      ok: true,
      value: {
        sessionId: session.id,
        session,
        pendingDecision: session.pendingUserDecision,
        decisions: session.decisions,
        directions: session.directions,
        events,
        latestEventId: session.events.at(-1)?.id,
      },
    };
  }

  async completeWork(input: CompleteWorkInput): Promise<CompleteWorkResult> {
    return this.externalWrite(input, async (session, now) => {
      const event: WorkCompletedEvent = {
        id: input.eventId,
        sessionId: input.sessionId,
        type: "work.completed",
        createdAt: now,
        completion: { completedAt: now, summary: input.summary },
      };
      const next = await this.commitEvent(session, event, input.expectedSessionUpdatedAt);
      return { sessionId: next.id, session: next, event };
    });
  }

  async failWork(input: FailWorkInput): Promise<FailWorkResult> {
    if (!input.error.message.trim()) {
      return failure("validation_error", "Failure message is required.", input.sessionId);
    }

    return this.externalWrite(input, async (session, now) => {
      if (session.status === "completed" || session.status === "failed") {
        throw new ExternalOperationError("invalid_session_state", `Cannot fail work after session is ${session.status}.`, false);
      }
      const event: WorkFailedEvent = {
        id: input.eventId,
        sessionId: input.sessionId,
        type: "work.failed",
        createdAt: now,
        error: {
          failedAt: now,
          message: input.error.message.trim(),
          code: input.error.code,
          cause: input.error.cause,
        },
      };
      const next = await this.commitEvent(session, event, input.expectedSessionUpdatedAt);
      return { sessionId: next.id, session: next, event };
    });
  }

  /** Temporary provider-driven execution path retained for the current frontend. */
  async startWithLegacyProvider(sessionId: string): Promise<WorkSession> {
    const provider = this.requireLegacyProvider();
    let session = await this.requireSession(sessionId);
    session = await this.commitEvent(session, {
      id: createId("event"),
      sessionId,
      type: "work.started",
      createdAt: this.clock.now(),
    });
    return this.consumeProviderEvents(session, provider.startWork({ session }));
  }

  async respondToUser(sessionId: string, response: string, selectedOptionId?: string): Promise<WorkSession> {
    let session = await this.requireSession(sessionId);
    if (!session.pendingUserDecision) {
      throw new Error(`Session ${sessionId} has no pending user decision`);
    }

    const decision: UserDecision = {
      id: createId("decision"),
      sessionId,
      requestId: session.pendingUserDecision.id,
      response,
      selectedOptionId,
      createdAt: this.clock.now(),
    };

    session = await this.commitEvent(session, {
      id: createId("event"),
      sessionId,
      type: "user.responded",
      decision,
      createdAt: decision.createdAt,
    });
    session = await this.commitEvent(session, {
      id: createId("event"),
      sessionId,
      type: "work.resumed",
      createdAt: this.clock.now(),
    });

    if (!this.aiProvider) {
      return session;
    }
    return this.consumeProviderEvents(session, this.aiProvider.continueWork({ session, decision }));
  }

  async provideDirection(sessionId: string, value: UserDirectionValue): Promise<WorkSession> {
    const session = await this.requireSession(sessionId);
    const now = this.clock.now();
    const direction = {
      id: createId("direction"),
      sessionId,
      kind: "visual_style" as const,
      value,
      instruction: directionInstructions[value],
      createdAt: now,
    };

    return this.commitEvent(session, {
      id: createId("event"),
      sessionId,
      type: "user.direction_provided",
      direction,
      activity: {
        id: createId("activity"),
        sessionId,
        message: `User shaped the result: ${direction.instruction}`,
        metadata: { source: "user", directionValue: value },
        createdAt: now,
      },
      createdAt: now,
    });
  }

  async getSession(sessionId: string): Promise<WorkSession | undefined> {
    return this.persistence.getSession(sessionId);
  }

  subscribe(sessionId: string, listener: RuntimeEventListener): () => void {
    const sessionListeners = this.listeners.get(sessionId) ?? new Set<RuntimeEventListener>();
    sessionListeners.add(listener);
    this.listeners.set(sessionId, sessionListeners);
    return () => {
      sessionListeners.delete(listener);
      if (sessionListeners.size === 0) this.listeners.delete(sessionId);
    };
  }

  private async persistNewSession(input: { id?: string; task: string; context?: Record<string, unknown> }): Promise<WorkSession> {
    const session = createWorkSession({ ...input, now: this.clock.now() });
    await this.persistence.saveSession(session);
    return session;
  }

  private requireLegacyProvider(): AiProvider {
    if (!this.aiProvider) {
      throw new Error("Legacy AI provider execution is not configured.");
    }
    return this.aiProvider;
  }

  private async requireSession(sessionId: string): Promise<WorkSession> {
    const session = await this.persistence.getSession(sessionId);
    if (!session) throw new Error(`Session ${sessionId} does not exist`);
    return session;
  }

  private async externalWrite<T>(
    input: ExternalAgentEventCommand,
    operation: (session: WorkSession, now: string) => Promise<T>,
  ): Promise<ExternalAgentResult<T>> {
    if (!input.eventId.trim()) {
      return failure("validation_error", "eventId is required.", input.sessionId);
    }
    try {
      const session = await this.requireSession(input.sessionId);
      if (session.events.some((event) => event.id === input.eventId)) {
        throw new ExternalOperationError("duplicate_event", `Duplicate runtime event id: ${input.eventId}`, false);
      }
      return { ok: true, value: await operation(session, this.clock.now()) };
    } catch (error) {
      return { ok: false, error: toExternalError(error, input.sessionId) };
    }
  }

  private async consumeProviderEvents(session: WorkSession, events: AsyncIterable<RuntimeEvent>): Promise<WorkSession> {
    let current = session;
    try {
      for await (const event of events) {
        current = await this.commitEvent(current, event);
        if (current.status === "needs_user" || current.status === "completed" || current.status === "failed") break;
      }
      return current;
    } catch (error) {
      const now = this.clock.now();
      return this.commitEvent(current, {
        id: createId("event"),
        sessionId: current.id,
        type: "work.failed",
        createdAt: now,
        error: {
          failedAt: now,
          message: error instanceof Error ? error.message : "AI provider execution failed",
          cause: error instanceof Error ? error.name : error,
        },
      });
    }
  }

  private async commitEvent(
    session: WorkSession,
    event: RuntimeEvent,
    expectedSessionUpdatedAt?: string,
  ): Promise<WorkSession> {
    const authoritativeSession = (await this.persistence.getSession(session.id)) ?? session;
    const isDuplicate = authoritativeSession.events.some((existing) => existing.id === event.id);
    if (
      expectedSessionUpdatedAt !== undefined
      && expectedSessionUpdatedAt !== authoritativeSession.updatedAt
      && !isDuplicate
    ) {
      throw new ExternalOperationError(
        "stale_event",
        `Expected session updatedAt ${expectedSessionUpdatedAt}, but current value is ${authoritativeSession.updatedAt}.`,
        true,
        { expectedSessionUpdatedAt, currentSessionUpdatedAt: authoritativeSession.updatedAt },
      );
    }

    if (event.type === "artifact.updated" && !isDuplicate) {
      const expectedArtifactVersion = (authoritativeSession.currentArtifact?.version ?? 0) + 1;
      if (event.artifact.version !== expectedArtifactVersion) {
        throw new ExternalOperationError(
          "artifact_version_conflict",
          `Artifact version ${event.artifact.version} cannot follow version ${expectedArtifactVersion - 1}.`,
          true,
          { artifactVersion: event.artifact.version, expectedArtifactVersion },
        );
      }
      if (
        authoritativeSession.currentArtifact
        && event.artifact.id !== authoritativeSession.currentArtifact.id
      ) {
        throw new ExternalOperationError(
          "artifact_version_conflict",
          `Artifact ${event.artifact.id} does not match current artifact ${authoritativeSession.currentArtifact.id}.`,
          false,
        );
      }
    }

    const next = applyRuntimeEvent(authoritativeSession, event);
    await this.persistence.appendEvent(event);
    if (event.type === "artifact.updated") await this.persistence.saveArtifact(event.artifact);
    if (event.type === "user.responded") await this.persistence.saveDecision(event.decision);
    if (event.type === "user.direction_provided") await this.persistence.saveDirection(event.direction);
    await this.persistence.saveSession(next);

    for (const listener of this.listeners.get(session.id) ?? []) {
      try {
        listener(structuredClone(next), structuredClone(event));
      } catch {
        // Observers cannot change or interrupt authoritative runtime processing.
      }
    }
    return next;
  }
}

class ExternalOperationError extends Error {
  constructor(
    readonly code: ExternalAgentErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

function isHumanInputEvent(event: RuntimeEvent): event is HumanInputRuntimeEvent {
  return event.type === "user.responded" || event.type === "user.direction_provided";
}

function failure<T>(
  code: ExternalAgentErrorCode,
  message: string,
  sessionId?: string,
  retryable = false,
  details?: Record<string, unknown>,
): ExternalAgentResult<T> {
  return { ok: false, error: { code, message, retryable, sessionId, details } };
}

function toExternalError(error: unknown, sessionId?: string): ExternalAgentError {
  if (error instanceof ExternalOperationError) {
    return { code: error.code, message: error.message, retryable: error.retryable, sessionId, details: error.details };
  }
  const message = error instanceof Error ? error.message : "Unexpected external-agent runtime error.";
  if (/does not exist/i.test(message)) return { code: "session_not_found", message, retryable: false, sessionId };
  if (/Duplicate runtime event/i.test(message)) return { code: "duplicate_event", message, retryable: false, sessionId };
  if (/Stale runtime event/i.test(message)) return { code: "stale_event", message, retryable: true, sessionId };
  if (/belongs to/i.test(message)) return { code: "wrong_session", message, retryable: false, sessionId };
  if (/Cannot|cannot|needs user|pending decision/i.test(message)) {
    return { code: "invalid_session_state", message, retryable: false, sessionId };
  }
  return { code: "internal_error", message, retryable: false, sessionId };
}
