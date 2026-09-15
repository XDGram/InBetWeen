import type {
  AiNeedsUserEvent,
  Artifact,
  ArtifactUpdatedEvent,
  ErrorState,
  RuntimeEvent,
  UserDecision,
  UserDecisionOption,
  UserDecisionRequest,
  UserDirection,
  UserDirectionProvidedEvent,
  UserRespondedEvent,
  WorkActivity,
  WorkActivityEvent,
  WorkCompletedEvent,
  WorkFailedEvent,
  WorkSession,
  WorkStartedEvent,
} from "./types.js";

export type ExternalAgentErrorCode =
  | "validation_error"
  | "session_not_found"
  | "invalid_session_state"
  | "wrong_session"
  | "duplicate_event"
  | "stale_event"
  | "artifact_version_conflict"
  | "conflict"
  | "internal_error";

export interface ExternalAgentError {
  code: ExternalAgentErrorCode;
  message: string;
  retryable: boolean;
  sessionId?: WorkSession["id"];
  details?: Record<string, unknown>;
}

export type ExternalAgentResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ExternalAgentError };

/**
 * Shared validation and idempotency fields for commands that produce a
 * RuntimeEvent. The eventId is the stable idempotency key for that event.
 */
export interface ExternalAgentEventCommand {
  sessionId: WorkSession["id"];
  eventId: RuntimeEvent["id"];
  expectedSessionUpdatedAt?: WorkSession["updatedAt"];
}

export interface RegisterSessionInput {
  /** Optional caller-selected ID; the runtime may generate one when omitted. */
  sessionId?: WorkSession["id"];
  task: WorkSession["task"];
  context?: Record<string, unknown>;
  /** Registration has no RuntimeEvent, so it uses a separate idempotency key. */
  idempotencyKey: string;
}

export interface RegisterSessionSuccess {
  sessionId: WorkSession["id"];
  session: WorkSession;
}

export type RegisterSessionResult = ExternalAgentResult<RegisterSessionSuccess>;

export interface StartWorkInput extends ExternalAgentEventCommand {}

export interface StartWorkSuccess {
  sessionId: WorkSession["id"];
  session: WorkSession;
  event: WorkStartedEvent;
}

export type StartWorkResult = ExternalAgentResult<StartWorkSuccess>;

export interface ReportActivityInput extends ExternalAgentEventCommand {
  activity: Pick<WorkActivity, "message"> & Partial<Pick<WorkActivity, "metadata">>;
}

export interface ReportActivitySuccess {
  sessionId: WorkSession["id"];
  session: WorkSession;
  event: WorkActivityEvent;
}

export type ReportActivityResult = ExternalAgentResult<ReportActivitySuccess>;

export interface PublishArtifactInput extends ExternalAgentEventCommand {
  artifactId?: Artifact["id"];
  artifact: Pick<Artifact, "kind" | "content"> & Partial<Pick<Artifact, "title" | "metadata">>;
  /** Expected current version before this update; zero creates the artifact. */
  expectedArtifactVersion: number;
}

export interface PublishArtifactSuccess {
  sessionId: WorkSession["id"];
  session: WorkSession;
  artifact: Artifact;
  event: ArtifactUpdatedEvent;
}

export type PublishArtifactResult = ExternalAgentResult<PublishArtifactSuccess>;

export interface RequestDecisionInput extends ExternalAgentEventCommand {
  decisionId?: UserDecisionRequest["id"];
  prompt: UserDecisionRequest["prompt"];
  options?: UserDecisionOption[];
  required: true;
}

export interface RequestDecisionSuccess {
  sessionId: WorkSession["id"];
  session: WorkSession;
  decision: UserDecisionRequest;
  event: AiNeedsUserEvent;
}

export type RequestDecisionResult = ExternalAgentResult<RequestDecisionSuccess>;

export interface GetHumanInputInput {
  sessionId: WorkSession["id"];
  /** Return human events after this event when supplied. */
  afterEventId?: RuntimeEvent["id"];
  limit?: number;
}

export type HumanInputRuntimeEvent = UserRespondedEvent | UserDirectionProvidedEvent;

export interface GetHumanInputSuccess {
  sessionId: WorkSession["id"];
  session: WorkSession;
  pendingDecision?: UserDecisionRequest;
  decisions: UserDecision[];
  directions: UserDirection[];
  events: HumanInputRuntimeEvent[];
  latestEventId?: RuntimeEvent["id"];
}

export type GetHumanInputResult = ExternalAgentResult<GetHumanInputSuccess>;

export interface CompleteWorkInput extends ExternalAgentEventCommand {
  summary?: NonNullable<WorkSession["completion"]>["summary"];
}

export interface CompleteWorkSuccess {
  sessionId: WorkSession["id"];
  session: WorkSession;
  event: WorkCompletedEvent;
}

export type CompleteWorkResult = ExternalAgentResult<CompleteWorkSuccess>;

export interface FailWorkInput extends ExternalAgentEventCommand {
  error: Pick<ErrorState, "message"> & Partial<Pick<ErrorState, "code" | "cause">>;
}

export interface FailWorkSuccess {
  sessionId: WorkSession["id"];
  session: WorkSession;
  event: WorkFailedEvent;
}

export type FailWorkResult = ExternalAgentResult<FailWorkSuccess>;

/**
 * Protocol-neutral command boundary for an external agent integration.
 * Implementations must delegate state transitions to the authoritative runtime.
 */
export interface ExternalAgentRuntimePort {
  registerSession(input: RegisterSessionInput): Promise<RegisterSessionResult>;
  startWork(input: StartWorkInput): Promise<StartWorkResult>;
  reportActivity(input: ReportActivityInput): Promise<ReportActivityResult>;
  publishArtifact(input: PublishArtifactInput): Promise<PublishArtifactResult>;
  requestDecision(input: RequestDecisionInput): Promise<RequestDecisionResult>;
  getHumanInput(input: GetHumanInputInput): Promise<GetHumanInputResult>;
  completeWork(input: CompleteWorkInput): Promise<CompleteWorkResult>;
  failWork(input: FailWorkInput): Promise<FailWorkResult>;
}
