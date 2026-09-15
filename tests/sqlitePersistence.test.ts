import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createConfiguredPersistence } from "../src/persistence/factory.js";
import { InMemoryPersistence } from "../src/persistence/inMemoryPersistence.js";
import { SqlitePersistence } from "../src/persistence/sqlitePersistence.js";
import { WorkRuntime } from "../src/runtime/workRuntime.js";
import type { ExternalAgentResult } from "../src/shared/externalAgent.js";
import type { RuntimeClock } from "../src/shared/ids.js";

test("persistence selection supports durable SQLite and explicit in-memory mode", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "inbetween-sqlite-"));
  const databasePath = join(directory, "configured.sqlite");
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const memory = createConfiguredPersistence({ INBETWEEN_PERSISTENCE: "memory" });
  const sqlite = createConfiguredPersistence({
    INBETWEEN_PERSISTENCE: "sqlite",
    INBETWEEN_SQLITE_PATH: databasePath,
  });

  assert.ok(memory instanceof InMemoryPersistence);
  assert.ok(sqlite instanceof SqlitePersistence);
  sqlite.close();
});

test("SQLite persists sessions, events, artifact versions and human input across runtime reinitialization", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "inbetween-sqlite-"));
  const databasePath = join(directory, "runtime.sqlite");
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const firstPersistence = new SqlitePersistence(databasePath);
  const firstRuntime = new WorkRuntime({ persistence: firstPersistence, clock: new TickingClock() });
  const registered = unwrap(await firstRuntime.registerSession({
    sessionId: "durable_session",
    idempotencyKey: "register_durable_session",
    task: "Create a durable landing page",
    context: { audience: "teams" },
  }));
  const started = unwrap(await firstRuntime.startWork({
    sessionId: registered.sessionId,
    eventId: "durable_started",
    expectedSessionUpdatedAt: registered.session.updatedAt,
  }));
  const activity = unwrap(await firstRuntime.reportActivity({
    sessionId: registered.sessionId,
    eventId: "durable_activity",
    expectedSessionUpdatedAt: started.session.updatedAt,
    activity: { message: "Created the structure." },
  }));
  const artifactV1 = unwrap(await firstRuntime.publishArtifact({
    sessionId: registered.sessionId,
    eventId: "durable_artifact_v1",
    expectedSessionUpdatedAt: activity.session.updatedAt,
    expectedArtifactVersion: 0,
    artifact: { kind: "website", content: "<h1>First version</h1>" },
  }));
  const artifactV2 = unwrap(await firstRuntime.publishArtifact({
    sessionId: registered.sessionId,
    eventId: "durable_artifact_v2",
    expectedSessionUpdatedAt: artifactV1.session.updatedAt,
    expectedArtifactVersion: 1,
    artifact: { kind: "website", content: "<h1>Second version</h1>" },
  }));
  const shaped = await firstRuntime.provideDirection(registered.sessionId, "minimal");
  const waiting = unwrap(await firstRuntime.requestDecision({
    sessionId: registered.sessionId,
    eventId: "durable_decision_request",
    expectedSessionUpdatedAt: shaped.updatedAt,
    prompt: "Should this stay editorial?",
    required: true,
    options: [{ id: "editorial", label: "Editorial" }],
  }));
  const resumed = await firstRuntime.respondToUser(registered.sessionId, "Yes", "editorial");
  assert.equal(resumed.status, "working");
  assert.equal(artifactV2.artifact.version, 2);
  assert.equal(waiting.session.status, "needs_user");
  firstPersistence.close();

  const secondPersistence = new SqlitePersistence(databasePath);
  const secondRuntime = new WorkRuntime({ persistence: secondPersistence, clock: new TickingClock(100) });
  const reloaded = await secondRuntime.getSession(registered.sessionId);
  assert.equal(reloaded?.status, "working");
  assert.equal(reloaded?.context?.audience, "teams");
  assert.equal(reloaded?.currentArtifact?.version, 2);
  assert.equal(reloaded?.currentArtifact?.content, "<h1>Second version</h1>");
  assert.equal((await secondPersistence.listEvents(registered.sessionId)).length, 8);
  assert.deepEqual((await secondPersistence.listArtifacts(registered.sessionId)).map((artifact) => artifact.version), [1, 2]);
  assert.equal((await secondPersistence.listDecisions(registered.sessionId))[0]?.response, "Yes");
  assert.equal((await secondPersistence.listDirections(registered.sessionId))[0]?.value, "minimal");

  const humanInput = unwrap(await secondRuntime.getHumanInput({ sessionId: registered.sessionId }));
  assert.equal(humanInput.decisions.length, 1);
  assert.equal(humanInput.directions.length, 1);
  assert.deepEqual(humanInput.events.map((event) => event.type), ["user.direction_provided", "user.responded"]);

  const completed = unwrap(await secondRuntime.completeWork({
    sessionId: registered.sessionId,
    eventId: "durable_completed",
    expectedSessionUpdatedAt: reloaded!.updatedAt,
    summary: "Durable lifecycle completed.",
  }));
  assert.equal(completed.session.status, "completed");
  secondPersistence.close();

  const thirdPersistence = new SqlitePersistence(databasePath);
  assert.equal((await thirdPersistence.getSession(registered.sessionId))?.status, "completed");
  assert.equal((await thirdPersistence.listEvents(registered.sessionId)).at(-1)?.type, "work.completed");
  thirdPersistence.close();
});

test("SQLite keeps duplicate event protection after reopening the database", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "inbetween-sqlite-"));
  const databasePath = join(directory, "duplicates.sqlite");
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const firstPersistence = new SqlitePersistence(databasePath);
  const firstRuntime = new WorkRuntime({ persistence: firstPersistence, clock: new TickingClock() });
  const registered = unwrap(await firstRuntime.registerSession({
    sessionId: "duplicate_session",
    idempotencyKey: "register_duplicate_session",
    task: "Protect event identity",
  }));
  unwrap(await firstRuntime.startWork({
    sessionId: registered.sessionId,
    eventId: "persisted_event_id",
    expectedSessionUpdatedAt: registered.session.updatedAt,
  }));
  firstPersistence.close();

  const reopenedPersistence = new SqlitePersistence(databasePath);
  const reopenedRuntime = new WorkRuntime({ persistence: reopenedPersistence, clock: new TickingClock(100) });
  const duplicate = await reopenedRuntime.reportActivity({
    sessionId: registered.sessionId,
    eventId: "persisted_event_id",
    activity: { message: "This must not be committed." },
  });
  assert.equal(duplicate.ok, false);
  if (!duplicate.ok) assert.equal(duplicate.error.code, "duplicate_event");
  assert.equal((await reopenedPersistence.listEvents(registered.sessionId)).length, 1);
  reopenedPersistence.close();
});

test("SQLite serializes competing writes with optimistic session validation", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "inbetween-sqlite-"));
  const databasePath = join(directory, "concurrency.sqlite");
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const persistenceA = new SqlitePersistence(databasePath);
  const persistenceB = new SqlitePersistence(databasePath);
  const runtimeA = new WorkRuntime({ persistence: persistenceA, clock: new TickingClock() });
  const runtimeB = new WorkRuntime({ persistence: persistenceB, clock: new TickingClock(100) });
  const registered = unwrap(await runtimeA.registerSession({
    sessionId: "concurrent_session",
    idempotencyKey: "register_concurrent_session",
    task: "Serialize writes",
  }));
  const started = unwrap(await runtimeA.startWork({
    sessionId: registered.sessionId,
    eventId: "concurrent_started",
    expectedSessionUpdatedAt: registered.session.updatedAt,
  }));

  const expectedSessionUpdatedAt = started.session.updatedAt;
  const [left, right] = await Promise.all([
    runtimeA.reportActivity({
      sessionId: registered.sessionId,
      eventId: "concurrent_left",
      expectedSessionUpdatedAt,
      activity: { message: "Left write" },
    }),
    runtimeB.reportActivity({
      sessionId: registered.sessionId,
      eventId: "concurrent_right",
      expectedSessionUpdatedAt,
      activity: { message: "Right write" },
    }),
  ]);

  assert.equal([left, right].filter((result) => result.ok).length, 1);
  const rejected = [left, right].find((result) => !result.ok);
  assert.ok(rejected && !rejected.ok);
  if (rejected && !rejected.ok) assert.equal(rejected.error.code, "stale_event");
  assert.equal((await persistenceA.listEvents(registered.sessionId)).length, 2);
  persistenceA.close();
  persistenceB.close();
});

function unwrap<T>(result: ExternalAgentResult<T>): T {
  if (!result.ok) assert.fail(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

class TickingClock implements RuntimeClock {
  constructor(private tick = 0) {}

  now(): string {
    const value = new Date(Date.UTC(2026, 8, 15, 0, 0, 0, this.tick)).toISOString();
    this.tick += 1;
    return value;
  }
}
