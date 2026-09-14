import assert from "node:assert/strict";
import test from "node:test";
import { applyRuntimeEvent, createWorkSession } from "../src/runtime/stateMachine.js";
import type { RuntimeEvent } from "../src/shared/types.js";

const now = "2026-09-14T00:00:00.000Z";

test("state machine follows idle -> working -> needs_user -> working -> completed", () => {
  let session = createWorkSession({ id: "session_1", task: "Build a product plan", now });
  assert.equal(session.status, "idle");

  session = applyRuntimeEvent(session, event({ type: "work.started" }));
  assert.equal(session.status, "working");

  session = applyRuntimeEvent(session, event({
    type: "ai.needs_user",
    decision: {
      id: "decision_request_1",
      sessionId: session.id,
      prompt: "Pick a direction",
      required: true,
      createdAt: now,
    },
  }));
  assert.equal(session.status, "needs_user");
  assert.equal(session.pendingUserDecision?.id, "decision_request_1");

  session = applyRuntimeEvent(session, event({
    type: "user.responded",
    decision: {
      id: "decision_1",
      sessionId: session.id,
      requestId: "decision_request_1",
      response: "Keep it concise",
      createdAt: now,
    },
  }));
  assert.equal(session.status, "needs_user");
  assert.equal(session.pendingUserDecision, undefined);
  assert.equal(session.decisions.length, 1);

  session = applyRuntimeEvent(session, event({ type: "work.resumed" }));
  assert.equal(session.status, "working");

  session = applyRuntimeEvent(session, event({
    type: "work.completed",
    completion: { completedAt: now, summary: "Done" },
  }));
  assert.equal(session.status, "completed");
});

test("state machine rejects invalid transitions", () => {
  const session = createWorkSession({ id: "session_1", task: "Build a product plan", now });
  assert.throws(() => applyRuntimeEvent(session, event({ type: "work.completed", completion: { completedAt: now } })), /Cannot complete work from idle/);
});

function event(input: { type: RuntimeEvent["type"] } & Record<string, unknown>): RuntimeEvent {
  return {
    id: `event_${input.type}`,
    sessionId: "session_1",
    createdAt: now,
    ...input,
  } as RuntimeEvent;
}

