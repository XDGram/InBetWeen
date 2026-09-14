import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryPersistence } from "../src/persistence/inMemoryPersistence.js";
import { WorkRuntime } from "../src/runtime/workRuntime.js";
import { ScriptedLifecycleProvider } from "./fixtures/scriptedLifecycleProvider.js";

test("runtime persists a complete user-shaped work lifecycle", async () => {
  const persistence = new InMemoryPersistence();
  const runtime = new WorkRuntime({
    aiProvider: new ScriptedLifecycleProvider(),
    persistence,
  });

  const created = await runtime.createSession("Create a concise product direction");
  assert.equal(created.status, "idle");

  const waiting = await runtime.startWork(created.id);
  assert.equal(waiting.status, "needs_user");
  assert.equal(waiting.activity.length, 1);
  assert.equal(waiting.currentArtifact?.version, 1);
  assert.equal(waiting.pendingUserDecision?.prompt, "Should the result stay concise or go deeper?");

  const completed = await runtime.respondToUser(created.id, "Keep it concise", "concise");
  assert.equal(completed.status, "completed");
  assert.equal(completed.decisions.length, 1);
  assert.equal(completed.currentArtifact?.version, 2);
  assert.match(completed.currentArtifact?.content ?? "", /Keep it concise/);

  const events = await persistence.listEvents(created.id);
  assert.deepEqual(events.map((event) => event.type), [
    "work.started",
    "work.activity",
    "artifact.updated",
    "ai.needs_user",
    "user.responded",
    "work.resumed",
    "work.activity",
    "artifact.updated",
    "work.completed",
  ]);

  const artifacts = await persistence.listArtifacts(created.id);
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0]?.version, 2);

  const decisions = await persistence.listDecisions(created.id);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0]?.selectedOptionId, "concise");
});
