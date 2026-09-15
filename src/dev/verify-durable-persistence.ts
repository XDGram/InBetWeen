import assert from "node:assert/strict";
import { resolve } from "node:path";
import { SqlitePersistence } from "../persistence/sqlitePersistence.js";
import { WorkRuntime } from "../runtime/workRuntime.js";
import { createId } from "../shared/ids.js";

const databasePath = resolve(process.env.INBETWEEN_DATA_DIR ?? ".inbetween-data", "durability-check.sqlite");
const sessionId = createId("durable_session");
const firstPersistence = new SqlitePersistence(databasePath);
const firstRuntime = new WorkRuntime({ persistence: firstPersistence });

const registered = await firstRuntime.registerSession({
  sessionId,
  idempotencyKey: createId("registration"),
  task: "Verify durable local InBetween persistence",
  context: { verification: "restart" },
});
assert.ok(registered.ok);
const started = await firstRuntime.startWork({
  sessionId,
  eventId: createId("event"),
  expectedSessionUpdatedAt: registered.value.session.updatedAt,
});
assert.ok(started.ok);
const activity = await firstRuntime.reportActivity({
  sessionId,
  eventId: createId("event"),
  expectedSessionUpdatedAt: started.value.session.updatedAt,
  activity: { message: "Persisted work activity before restart." },
});
assert.ok(activity.ok);
const artifact = await firstRuntime.publishArtifact({
  sessionId,
  eventId: createId("event"),
  expectedSessionUpdatedAt: activity.value.session.updatedAt,
  expectedArtifactVersion: 0,
  artifact: { kind: "website", content: "<!doctype html><h1>Durable artifact</h1>" },
});
assert.ok(artifact.ok);
firstPersistence.close();

const reopenedPersistence = new SqlitePersistence(databasePath);
const reopenedRuntime = new WorkRuntime({ persistence: reopenedPersistence });
const restored = await reopenedRuntime.getSession(sessionId);
const events = await reopenedPersistence.listEvents(sessionId);

assert.equal(restored?.status, "working");
assert.equal(restored?.currentArtifact?.version, 1);
assert.deepEqual(events.map((event) => event.type), ["work.started", "work.activity", "artifact.updated"]);
console.log(JSON.stringify({
  databasePath,
  sessionId,
  restoredStatus: restored.status,
  artifactVersion: restored.currentArtifact?.version,
  eventTypes: events.map((event) => event.type),
}, null, 2));
reopenedPersistence.close();
