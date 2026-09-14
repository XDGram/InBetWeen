import { InMemoryPersistence } from "../persistence/inMemoryPersistence.js";
import { WorkRuntime } from "../runtime/workRuntime.js";
import type { AiContinueContext, AiProvider, AiStartContext } from "../ai/provider.js";
import type { RuntimeEvent } from "../shared/types.js";

class DevLifecycleProvider implements AiProvider {
  async *startWork(context: AiStartContext): AsyncIterable<RuntimeEvent> {
    const now = new Date().toISOString();
    yield {
      id: "dev_activity_1",
      sessionId: context.session.id,
      type: "work.activity",
      createdAt: now,
      activity: {
        id: "dev_activity_record_1",
        sessionId: context.session.id,
        message: "Provider produced initial activity.",
        createdAt: now,
      },
    };

    yield {
      id: "dev_artifact_1",
      sessionId: context.session.id,
      type: "artifact.updated",
      createdAt: now,
      artifact: {
        id: "dev_artifact",
        sessionId: context.session.id,
        kind: "markdown",
        version: 1,
        title: "Runtime Proof Artifact",
        content: "# Runtime Proof Artifact\n\nWaiting for a user decision.",
        createdAt: now,
        updatedAt: now,
      },
    };

    yield {
      id: "dev_needs_user_1",
      sessionId: context.session.id,
      type: "ai.needs_user",
      createdAt: now,
      decision: {
        id: "dev_decision_request_1",
        sessionId: context.session.id,
        prompt: "Choose how the artifact should finish.",
        required: true,
        createdAt: now,
        options: [
          { id: "short", label: "Short" },
          { id: "detailed", label: "Detailed" },
        ],
      },
    };
  }

  async *continueWork(context: AiContinueContext): AsyncIterable<RuntimeEvent> {
    const now = new Date().toISOString();
    yield {
      id: "dev_activity_2",
      sessionId: context.session.id,
      type: "work.activity",
      createdAt: now,
      activity: {
        id: "dev_activity_record_2",
        sessionId: context.session.id,
        message: "Provider continued after user input.",
        createdAt: now,
      },
    };

    yield {
      id: "dev_artifact_2",
      sessionId: context.session.id,
      type: "artifact.updated",
      createdAt: now,
      artifact: {
        id: "dev_artifact",
        sessionId: context.session.id,
        kind: "markdown",
        version: 2,
        title: "Runtime Proof Artifact",
        content: `# Runtime Proof Artifact\n\nCompleted with decision: ${context.decision.response}`,
        createdAt: context.session.currentArtifact?.createdAt ?? now,
        updatedAt: now,
      },
    };

    yield {
      id: "dev_completed_1",
      sessionId: context.session.id,
      type: "work.completed",
      createdAt: now,
      completion: {
        completedAt: now,
        summary: "The runtime lifecycle completed.",
      },
    };
  }
}

const persistence = new InMemoryPersistence();
const runtime = new WorkRuntime({ aiProvider: new DevLifecycleProvider(), persistence });

const created = await runtime.createSession("Prove the InBetween runtime lifecycle");
const waiting = await runtime.startWork(created.id);
console.log(JSON.stringify({ step: "after_start", status: waiting.status, pendingDecision: waiting.pendingUserDecision?.prompt }, null, 2));

const completed = await runtime.respondToUser(created.id, "Finish it short", "short");
console.log(JSON.stringify({
  step: "after_response",
  status: completed.status,
  artifactVersion: completed.currentArtifact?.version,
  eventTypes: (await persistence.listEvents(created.id)).map((event) => event.type),
}, null, 2));
