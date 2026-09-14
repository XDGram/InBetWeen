import type { RuntimeEvent, WorkSession } from "../shared/types.js";

export interface RuntimeEventEnvelope {
  event: RuntimeEvent;
  session: WorkSession;
}

export interface CreateSessionRequest {
  task: string;
}

export interface SubmitDecisionRequest {
  response: string;
  selectedOptionId?: string;
}

export interface AcceptedCommand {
  accepted: true;
  sessionId: string;
}

export interface ApiError {
  error: string;
}
