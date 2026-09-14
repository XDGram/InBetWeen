import { createId } from "../shared/ids.js";
import type { CreateWorkSessionInput, RuntimeEvent, WorkSession } from "../shared/types.js";

const terminalStatuses = new Set(["completed", "failed"]);

export function createWorkSession(input: CreateWorkSessionInput): WorkSession {
  const now = input.now ?? new Date().toISOString();

  return {
    id: input.id ?? createId("session"),
    task: input.task,
    status: "idle",
    activity: [],
    decisions: [],
    events: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function applyRuntimeEvent(session: WorkSession, event: RuntimeEvent): WorkSession {
  if (session.id !== event.sessionId) {
    throw new Error(`Event ${event.id} belongs to ${event.sessionId}, not ${session.id}`);
  }

  if (session.events.some((existing) => existing.id === event.id)) {
    throw new Error(`Duplicate runtime event id: ${event.id}`);
  }

  if (Date.parse(event.createdAt) < Date.parse(session.updatedAt)) {
    throw new Error(`Stale runtime event ${event.id} cannot be applied to session ${session.id}`);
  }

  if (terminalStatuses.has(session.status) && event.type !== "work.failed") {
    throw new Error(`Cannot apply ${event.type} after session is ${session.status}`);
  }

  const next: WorkSession = {
    ...session,
    events: [...session.events, event],
    updatedAt: event.createdAt,
  };

  switch (event.type) {
    case "work.started": {
      if (session.status !== "idle") {
        throw new Error(`Cannot start work from ${session.status}`);
      }
      return { ...next, status: "working", startedAt: event.createdAt, error: undefined };
    }

    case "work.activity": {
      if (session.status !== "working") {
        throw new Error(`Cannot record work activity while ${session.status}`);
      }
      return { ...next, activity: [...session.activity, event.activity] };
    }

    case "artifact.updated": {
      if (session.status !== "working") {
        throw new Error(`Cannot update artifact while ${session.status}`);
      }
      if (event.artifact.sessionId !== session.id) {
        throw new Error(`Artifact ${event.artifact.id} belongs to ${event.artifact.sessionId}, not ${session.id}`);
      }
      return { ...next, currentArtifact: event.artifact };
    }

    case "ai.needs_user": {
      if (session.status !== "working") {
        throw new Error(`AI cannot request user input while ${session.status}`);
      }
      if (event.decision.sessionId !== session.id) {
        throw new Error(`Decision request ${event.decision.id} belongs to ${event.decision.sessionId}, not ${session.id}`);
      }
      return { ...next, status: "needs_user", pendingUserDecision: event.decision };
    }

    case "user.responded": {
      if (session.status !== "needs_user" || !session.pendingUserDecision) {
        throw new Error("Cannot accept a user response without a pending decision");
      }
      if (event.decision.requestId !== session.pendingUserDecision.id) {
        throw new Error(`Decision ${event.decision.id} does not answer pending request ${session.pendingUserDecision.id}`);
      }
      return {
        ...next,
        decisions: [...session.decisions, event.decision],
        pendingUserDecision: undefined,
      };
    }

    case "work.resumed": {
      if (session.status !== "needs_user") {
        throw new Error(`Cannot resume work from ${session.status}`);
      }
      return { ...next, status: "working" };
    }

    case "work.completed": {
      if (session.status !== "working") {
        throw new Error(`Cannot complete work from ${session.status}`);
      }
      return { ...next, status: "completed", completion: event.completion };
    }

    case "work.failed": {
      return { ...next, status: "failed", error: event.error };
    }
  }
}
