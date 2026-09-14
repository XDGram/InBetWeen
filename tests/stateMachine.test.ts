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

test("a user direction records activity while the session remains working", () => {
  let session = applyRuntimeEvent(
    createWorkSession({ id: "session_1", task: "Create a landing page", now }),
    event({ id: "event_started", type: "work.started" }),
  );

  session = applyRuntimeEvent(session, directionEvent());

  assert.equal(session.status, "working");
  assert.equal(session.directions[0]?.value, "minimal");
  assert.equal(session.activity[0]?.metadata?.source, "user");
});

test("a user direction rejects wrong-session and terminal mutations", () => {
  const working = applyRuntimeEvent(
    createWorkSession({ id: "session_1", task: "Create a landing page", now }),
    event({ id: "event_started", type: "work.started" }),
  );
  assert.throws(() => applyRuntimeEvent(working, directionEvent("another_session")), /belongs to another_session/);

  const completed = applyRuntimeEvent(working, event({
    id: "event_completed",
    type: "work.completed",
    completion: { completedAt: now },
  }));
  assert.throws(() => applyRuntimeEvent(completed, directionEvent()), /Cannot apply user.direction_provided after session is completed/);

  const failed = applyRuntimeEvent(working, event({
    id: "event_failed",
    type: "work.failed",
    error: { failedAt: now, message: "Failed" },
  }));
  assert.throws(() => applyRuntimeEvent(failed, directionEvent()), /Cannot apply user.direction_provided after session is failed/);
});

function directionEvent(directionSessionId = "session_1"): RuntimeEvent {
  return event({
    id: `event_direction_${directionSessionId}`,
    type: "user.direction_provided",
    direction: {
      id: `direction_${directionSessionId}`,
      sessionId: directionSessionId,
      kind: "visual_style",
      value: "minimal",
      instruction: "Use a minimal visual direction.",
      createdAt: now,
    },
    activity: {
      id: `activity_${directionSessionId}`,
      sessionId: "session_1",
      message: "User shaped the result: minimal.",
      metadata: { source: "user" },
      createdAt: now,
    },
  });
}

function event(input: { type: RuntimeEvent["type"]; id?: string; createdAt?: string } & Record<string, unknown>): RuntimeEvent {
  const { id, createdAt, ...rest } = input;
  return {
    id: id ?? `event_${input.type}`,
    sessionId: "session_1",
    createdAt: createdAt ?? now,
    ...rest,
  } as RuntimeEvent;
}
