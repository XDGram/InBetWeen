import type { RuntimeEvent, UserDecision, WorkSession } from "../shared/types.js";

export interface AiStartContext {
  session: WorkSession;
}

export interface AiContinueContext {
  session: WorkSession;
  decision: UserDecision;
}

export interface AiProvider {
  startWork(context: AiStartContext): AsyncIterable<RuntimeEvent>;
  continueWork(context: AiContinueContext): AsyncIterable<RuntimeEvent>;
}
