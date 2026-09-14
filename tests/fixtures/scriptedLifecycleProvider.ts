import type { AiContinueContext, AiProvider, AiStartContext } from "../../src/ai/provider.js";
import type { RuntimeEvent } from "../../src/shared/types.js";

export class ScriptedLifecycleProvider implements AiProvider {
  async *startWork(context: AiStartContext): AsyncIterable<RuntimeEvent> {
    const now = new Date().toISOString();
    yield {
      id: "event_activity_initial",
      sessionId: context.session.id,
      type: "work.activity",
      createdAt: now,
      activity: {
        id: "activity_initial",
        sessionId: context.session.id,
        message: "Drafted the first artifact direction.",
        createdAt: now,
      },
    };

    yield {
      id: "event_artifact_initial",
      sessionId: context.session.id,
      type: "artifact.updated",
      createdAt: now,
      artifact: {
        id: "artifact_core",
        sessionId: context.session.id,
        kind: "website",
        version: 1,
        title: "Initial Landing Page",
        content: "<!doctype html><html><body><h1>Initial direction</h1><p>The artifact needs one product decision.</p></body></html>",
        metadata: { taskType: "landing-page", format: "single-file-html" },
        createdAt: now,
        updatedAt: now,
      },
    };

    yield {
      id: "event_needs_user",
      sessionId: context.session.id,
      type: "ai.needs_user",
      createdAt: now,
      decision: {
        id: "decision_request_tone",
        sessionId: context.session.id,
        prompt: "Should the result stay concise or go deeper?",
        required: true,
        createdAt: now,
        options: [
          { id: "concise", label: "Concise" },
          { id: "deeper", label: "Deeper" },
        ],
      },
    };
  }

  async *continueWork(context: AiContinueContext): AsyncIterable<RuntimeEvent> {
    const now = new Date().toISOString();
    yield {
      id: "event_activity_after_decision",
      sessionId: context.session.id,
      type: "work.activity",
      createdAt: now,
      activity: {
        id: "activity_after_decision",
        sessionId: context.session.id,
        message: `Applied user decision: ${context.decision.response}`,
        createdAt: now,
      },
    };

    yield {
      id: "event_artifact_final",
      sessionId: context.session.id,
      type: "artifact.updated",
      createdAt: now,
      artifact: {
        id: "artifact_core",
        sessionId: context.session.id,
        kind: "website",
        version: 2,
        title: "Completed Landing Page",
        content: `<!doctype html><html><body><h1>Completed direction</h1><p>Finalized with user input: ${context.decision.response}</p></body></html>`,
        metadata: {
          taskType: "landing-page",
          format: "single-file-html",
          decisionInfluence: context.decision.response,
        },
        createdAt: context.session.currentArtifact?.createdAt ?? now,
        updatedAt: now,
      },
    };

    yield {
      id: "event_completed",
      sessionId: context.session.id,
      type: "work.completed",
      createdAt: now,
      completion: {
        completedAt: now,
        summary: "Lifecycle completed after user decision.",
      },
    };
  }
}
