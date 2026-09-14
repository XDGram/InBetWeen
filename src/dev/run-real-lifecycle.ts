import { createConfiguredAiProvider } from "../ai/factory.js";
import { InMemoryPersistence } from "../persistence/inMemoryPersistence.js";
import { WorkRuntime } from "../runtime/workRuntime.js";
import { loadDotEnv } from "./loadDotEnv.js";

loadDotEnv();

const task = process.env.INBETWEEN_DEV_TASK ?? "Create a landing page for a modern productivity app called InBetween.";
const decisionResponse = process.env.INBETWEEN_DEV_DECISION ?? "Use a minimal editorial style with crisp product messaging.";
const selectedOptionId = process.env.INBETWEEN_DEV_DECISION_OPTION;

const runtime = new WorkRuntime({
  aiProvider: createConfiguredAiProvider(),
  persistence: new InMemoryPersistence(),
});

const created = await runtime.createSession(task);
console.log(JSON.stringify({ step: "created", sessionId: created.id, status: created.status, task }, null, 2));

const waiting = await runtime.startWork(created.id);
console.log(JSON.stringify({
  step: "after_real_ai_start",
  status: waiting.status,
  activity: waiting.activity.map((item) => item.message),
  artifact: waiting.currentArtifact ? {
    kind: waiting.currentArtifact.kind,
    title: waiting.currentArtifact.title,
    version: waiting.currentArtifact.version,
    chars: waiting.currentArtifact.content.length,
  } : undefined,
  pendingDecision: waiting.pendingUserDecision,
  error: waiting.error,
}, null, 2));

if (waiting.status !== "needs_user") {
  process.exitCode = 1;
  console.error(`Expected real AI to request a user decision, got ${waiting.status}.`);
} else {
  const completed = await runtime.respondToUser(created.id, decisionResponse, selectedOptionId);
  console.log(JSON.stringify({
    step: "after_user_decision_and_real_ai_resume",
    status: completed.status,
    decisionResponse,
    artifact: completed.currentArtifact ? {
      kind: completed.currentArtifact.kind,
      title: completed.currentArtifact.title,
      version: completed.currentArtifact.version,
      chars: completed.currentArtifact.content.length,
      preview: completed.currentArtifact.content.slice(0, 240),
    } : undefined,
    completion: completed.completion,
    error: completed.error,
  }, null, 2));

  if (completed.status !== "completed") {
    process.exitCode = 1;
  }
}
