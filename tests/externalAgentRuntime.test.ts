import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryPersistence } from "../src/persistence/inMemoryPersistence.js";
import { WorkRuntime } from "../src/runtime/workRuntime.js";
import type { ExternalAgentResult, ExternalAgentRuntimePort } from "../src/shared/externalAgent.js";
import type { RuntimeClock } from "../src/shared/ids.js";

test("WorkRuntime implements the complete external-agent lifecycle through RuntimeEvents", async () => {
  const persistence = new InMemoryPersistence();
  const runtime = new WorkRuntime({ persistence, clock: new TickingClock() });
  const port: ExternalAgentRuntimePort = runtime;
  const published: string[] = [];

  const registered = unwrap(await port.registerSession({
    sessionId: "external_session",
    idempotencyKey: "register_external_session",
    task: "Create a landing page for InBetween",
    context: { audience: "product teams" },
  }));
  assert.equal(registered.session.context?.audience, "product teams");

  const unsubscribe = runtime.subscribe(registered.sessionId, (_session, event) => published.push(event.type));
  const started = unwrap(await port.startWork({
    sessionId: registered.sessionId,
    eventId: "external_started",
    expectedSessionUpdatedAt: registered.session.updatedAt,
  }));
  const activity = unwrap(await port.reportActivity({
    sessionId: registered.sessionId,
    eventId: "external_activity",
    expectedSessionUpdatedAt: started.session.updatedAt,
    activity: { message: "Created the page structure.", metadata: { stage: "structure" } },
  }));
  const initialArtifact = unwrap(await port.publishArtifact({
    sessionId: registered.sessionId,
    eventId: "external_artifact_v1",
    expectedSessionUpdatedAt: activity.session.updatedAt,
    expectedArtifactVersion: 0,
    artifact: {
      kind: "website",
      title: "InBetween",
      content: "<!doctype html><h1>Initial</h1>",
      metadata: { taskType: "landing-page", format: "single-file-html" },
    },
  }));
  assert.equal(initialArtifact.artifact.version, 1);

  const shaped = await runtime.provideDirection(registered.sessionId, "minimal");
  const waiting = unwrap(await port.requestDecision({
    sessionId: registered.sessionId,
    eventId: "external_needs_user",
    expectedSessionUpdatedAt: shaped.updatedAt,
    prompt: "Should the final style be editorial or energetic?",
    required: true,
    options: [
      { id: "editorial", label: "Editorial" },
      { id: "energetic", label: "Energetic" },
    ],
  }));
  assert.equal(waiting.session.status, "needs_user");

  const resumed = await runtime.respondToUser(registered.sessionId, "Use editorial", "editorial");
  assert.equal(resumed.status, "working");

  const humanInput = unwrap(await port.getHumanInput({
    sessionId: registered.sessionId,
    afterEventId: waiting.event.id,
  }));
  assert.equal(humanInput.decisions[0]?.response, "Use editorial");
  assert.equal(humanInput.directions[0]?.value, "minimal");
  assert.deepEqual(humanInput.events.map((event) => event.type), ["user.responded"]);

  const finalArtifact = unwrap(await port.publishArtifact({
    sessionId: registered.sessionId,
    eventId: "external_artifact_v2",
    expectedSessionUpdatedAt: resumed.updatedAt,
    expectedArtifactVersion: 1,
    artifact: { kind: "website", title: "InBetween", content: "<!doctype html><h1>Minimal editorial</h1>" },
  }));
  const completed = unwrap(await port.completeWork({
    sessionId: registered.sessionId,
    eventId: "external_completed",
    expectedSessionUpdatedAt: finalArtifact.session.updatedAt,
    summary: "Applied human input.",
  }));
  unsubscribe();

  assert.equal(completed.session.status, "completed");
  assert.deepEqual((await persistence.listEvents(registered.sessionId)).map((event) => event.type), [
    "work.started",
    "work.activity",
    "artifact.updated",
    "user.direction_provided",
    "ai.needs_user",
    "user.responded",
    "work.resumed",
    "artifact.updated",
    "work.completed",
  ]);
  assert.deepEqual(published, [
    "work.started",
    "work.activity",
    "artifact.updated",
    "user.direction_provided",
    "ai.needs_user",
    "user.responded",
    "work.resumed",
    "artifact.updated",
    "work.completed",
  ]);
});

test("external-agent writes reject duplicate event ids and stale session versions", async () => {
  const runtime = new WorkRuntime({ persistence: new InMemoryPersistence(), clock: new TickingClock() });
  const registered = unwrap(await runtime.registerSession({
    sessionId: "validation_session",
    idempotencyKey: "register_validation_session",
    task: "Validate external writes",
  }));
  const started = unwrap(await runtime.startWork({
    sessionId: registered.sessionId,
    eventId: "start_once",
    expectedSessionUpdatedAt: registered.session.updatedAt,
  }));

  const duplicate = await runtime.reportActivity({
    sessionId: registered.sessionId,
    eventId: "start_once",
    activity: { message: "Duplicate" },
  });
  assert.equal(duplicate.ok, false);
  if (!duplicate.ok) assert.equal(duplicate.error.code, "duplicate_event");

  const stale = await runtime.reportActivity({
    sessionId: registered.sessionId,
    eventId: "stale_activity",
    expectedSessionUpdatedAt: registered.session.updatedAt,
    activity: { message: "Based on stale state" },
  });
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.error.code, "stale_event");
  assert.equal((await runtime.getSession(registered.sessionId))?.updatedAt, started.session.updatedAt);
});

test("external artifact writes reject stale versions", async () => {
  const runtime = new WorkRuntime({ persistence: new InMemoryPersistence(), clock: new TickingClock() });
  const registered = unwrap(await runtime.registerSession({
    sessionId: "artifact_session",
    idempotencyKey: "register_artifact_session",
    task: "Create an artifact",
  }));
  const started = unwrap(await runtime.startWork({
    sessionId: registered.sessionId,
    eventId: "artifact_start",
    expectedSessionUpdatedAt: registered.session.updatedAt,
  }));
  const first = unwrap(await runtime.publishArtifact({
    sessionId: registered.sessionId,
    eventId: "artifact_v1",
    expectedSessionUpdatedAt: started.session.updatedAt,
    expectedArtifactVersion: 0,
    artifact: { kind: "website", content: "<h1>One</h1>" },
  }));

  const stale = await runtime.publishArtifact({
    sessionId: registered.sessionId,
    eventId: "artifact_stale",
    expectedSessionUpdatedAt: first.session.updatedAt,
    expectedArtifactVersion: 0,
    artifact: { kind: "website", content: "<h1>Stale</h1>" },
  });
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.error.code, "artifact_version_conflict");
  assert.equal((await runtime.getSession(registered.sessionId))?.currentArtifact?.content, "<h1>One</h1>");
});

test("external failWork terminates a working session", async () => {
  const runtime = new WorkRuntime({ persistence: new InMemoryPersistence(), clock: new TickingClock() });
  const registered = unwrap(await runtime.registerSession({
    sessionId: "failed_session",
    idempotencyKey: "register_failed_session",
    task: "Fail safely",
  }));
  const started = unwrap(await runtime.startWork({
    sessionId: registered.sessionId,
    eventId: "failed_start",
    expectedSessionUpdatedAt: registered.session.updatedAt,
  }));
  const failed = unwrap(await runtime.failWork({
    sessionId: registered.sessionId,
    eventId: "external_failed",
    expectedSessionUpdatedAt: started.session.updatedAt,
    error: { message: "The external agent stopped.", code: "AGENT_STOPPED" },
  }));

  assert.equal(failed.event.type, "work.failed");
  assert.equal(failed.session.status, "failed");
  assert.equal(failed.session.error?.code, "AGENT_STOPPED");
});

function unwrap<T>(result: ExternalAgentResult<T>): T {
  if (!result.ok) assert.fail(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

class TickingClock implements RuntimeClock {
  private tick = 0;

  now(): string {
    const value = new Date(Date.UTC(2026, 8, 15, 0, 0, 0, this.tick)).toISOString();
    this.tick += 1;
    return value;
  }
}
