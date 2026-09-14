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
    id: "event_needs_user",
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
    id: "event_user_responded",
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

  session = applyRuntimeEvent(session, event({ id: "event_resumed", type: "work.resumed" }));
  assert.equal(session.status, "working");

  session = applyRuntimeEvent(session, event({
    id: "event_completed",
    type: "work.completed",
    completion: { completedAt: now, summary: "Done" },
  }));
  assert.equal(session.status, "completed");
});

test("state machine rejects invalid transitions", () => {
  const session = createWorkSession({ id: "session_1", task: "Build a product plan", now });
  assert.throws(() => applyRuntimeEvent(session, event({ type: "work.completed", completion: { completedAt: now } })), /Cannot complete work from idle/);
});

test("state machine rejects duplicate and stale events", () => {
  const session = applyRuntimeEvent(
    createWorkSession({ id: "session_1", task: "Build a product plan", now }),
    event({ id: "event_started", type: "work.started" }),
  );

  assert.throws(() => applyRuntimeEvent(session, event({ id: "event_started", type: "work.activity", activity: {
    id: "activity_1",
    sessionId: "session_1",
    message: "Duplicate",
    createdAt: now,
  } })), /Duplicate runtime event id/);

  assert.throws(() => applyRuntimeEvent(session, event({
    id: "event_stale",
    type: "work.activity",
    createdAt: "2026-09-13T23:59:59.000Z",
    activity: {
      id: "activity_2",
      sessionId: "session_1",
      message: "Stale",
      createdAt: "2026-09-13T23:59:59.000Z",
    },
  })), /Stale runtime event/);
});

function event(input: { type: RuntimeEvent["type"]; id?: string; createdAt?: string } & Record<string, unknown>): RuntimeEvent {
  const { id, createdAt, ...rest } = input;
  return {
    id: id ?? `event_${input.type}`,
    sessionId: "session_1",
    createdAt: createdAt ?? now,
    ...rest,
  } as RuntimeEvent;
}
