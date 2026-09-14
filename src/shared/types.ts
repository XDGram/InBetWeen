export const WORK_SESSION_STATUSES = [
  "idle",
  "working",
  "needs_user",
  "completed",
  "failed",
] as const;

export type WorkSessionStatus = (typeof WORK_SESSION_STATUSES)[number];

export type ArtifactKind = "text" | "json" | "markdown" | "website";

export interface WebsiteArtifactMetadata {
  taskType: "landing-page";
  format: "single-file-html";
  decisionInfluence?: string;
}

export interface Artifact {
  id: string;
  sessionId: string;
  kind: ArtifactKind;
  version: number;
  title?: string;
  content: string;
  metadata?: Record<string, unknown> | WebsiteArtifactMetadata;
  createdAt: string;
  updatedAt: string;
}

export interface WorkActivity {
  id: string;
  sessionId: string;
  message: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface UserDecisionRequest {
  id: string;
  sessionId: string;
  prompt: string;
  options?: UserDecisionOption[];
  required: boolean;
  createdAt: string;
}

export interface UserDecisionOption {
  id: string;
  label: string;
  description?: string;
}

export interface UserDecision {
  id: string;
  sessionId: string;
  requestId: string;
  response: string;
  selectedOptionId?: string;
  createdAt: string;
}

export interface CompletionState {
  completedAt: string;
  summary?: string;
}

export interface ErrorState {
  failedAt: string;
  message: string;
  code?: string;
  cause?: unknown;
}

export interface WorkSession {
  id: string;
  task: string;
  status: WorkSessionStatus;
  currentArtifact?: Artifact;
  activity: WorkActivity[];
  pendingUserDecision?: UserDecisionRequest;
  decisions: UserDecision[];
  events: RuntimeEvent[];
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completion?: CompletionState;
  error?: ErrorState;
}

interface BaseRuntimeEvent {
  id: string;
  sessionId: string;
  createdAt: string;
}

export interface WorkStartedEvent extends BaseRuntimeEvent {
  type: "work.started";
}

export interface WorkActivityEvent extends BaseRuntimeEvent {
  type: "work.activity";
  activity: WorkActivity;
}

export interface ArtifactUpdatedEvent extends BaseRuntimeEvent {
  type: "artifact.updated";
  artifact: Artifact;
}

export interface AiNeedsUserEvent extends BaseRuntimeEvent {
  type: "ai.needs_user";
  decision: UserDecisionRequest;
}

export interface UserRespondedEvent extends BaseRuntimeEvent {
  type: "user.responded";
  decision: UserDecision;
}

export interface WorkResumedEvent extends BaseRuntimeEvent {
  type: "work.resumed";
}

export interface WorkCompletedEvent extends BaseRuntimeEvent {
  type: "work.completed";
  completion: CompletionState;
}

export interface WorkFailedEvent extends BaseRuntimeEvent {
  type: "work.failed";
  error: ErrorState;
}

export type RuntimeEvent =
  | WorkStartedEvent
  | WorkActivityEvent
  | ArtifactUpdatedEvent
  | AiNeedsUserEvent
  | UserRespondedEvent
  | WorkResumedEvent
  | WorkCompletedEvent
  | WorkFailedEvent;

export interface CreateWorkSessionInput {
  id?: string;
  task: string;
  now?: string;
}
