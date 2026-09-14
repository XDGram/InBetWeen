import type { AiProvider } from "../ai/provider.js";
import type { PersistenceAdapter } from "../persistence/persistence.js";
import { createId, type RuntimeClock, SystemClock } from "../shared/ids.js";
import type { RuntimeEvent, UserDecision, WorkSession } from "../shared/types.js";
import { applyRuntimeEvent, createWorkSession } from "./stateMachine.js";

export interface WorkRuntimeOptions {
  aiProvider: AiProvider;
  persistence: PersistenceAdapter;
  clock?: RuntimeClock;
}

export class WorkRuntime {
  private readonly aiProvider: AiProvider;
  private readonly persistence: PersistenceAdapter;
  private readonly clock: RuntimeClock;

  constructor(options: WorkRuntimeOptions) {
    this.aiProvider = options.aiProvider;
    this.persistence = options.persistence;
    this.clock = options.clock ?? new SystemClock();
  }

  async createSession(task: string): Promise<WorkSession> {
    const session = createWorkSession({ task, now: this.clock.now() });
    await this.persistence.saveSession(session);
    return session;
  }

  async startWork(sessionId: string): Promise<WorkSession> {
    let session = await this.requireSession(sessionId);
    session = await this.commitEvent(session, {
      id: createId("event"),
      sessionId,
      type: "work.started",
      createdAt: this.clock.now(),
    });

    return this.consumeProviderEvents(session, this.aiProvider.startWork({ session }));
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

    return this.consumeProviderEvents(session, this.aiProvider.continueWork({ session, decision }));
  }

  async getSession(sessionId: string): Promise<WorkSession | undefined> {
    return this.persistence.getSession(sessionId);
  }

  private async requireSession(sessionId: string): Promise<WorkSession> {
    const session = await this.persistence.getSession(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} does not exist`);
    }
    return session;
  }

  private async consumeProviderEvents(session: WorkSession, events: AsyncIterable<RuntimeEvent>): Promise<WorkSession> {
    let current = session;
    for await (const event of events) {
      current = await this.commitEvent(current, event);
      if (current.status === "needs_user" || current.status === "completed" || current.status === "failed") {
        break;
      }
    }
    return current;
  }

  private async commitEvent(session: WorkSession, event: RuntimeEvent): Promise<WorkSession> {
    const next = applyRuntimeEvent(session, event);
    await this.persistence.appendEvent(event);

    if (event.type === "artifact.updated") {
      await this.persistence.saveArtifact(event.artifact);
    }

    if (event.type === "user.responded") {
      await this.persistence.saveDecision(event.decision);
    }

    await this.persistence.saveSession(next);
    return next;
  }
}
