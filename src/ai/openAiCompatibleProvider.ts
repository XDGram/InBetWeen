import { createId } from "../shared/ids.js";
import type {
  Artifact,
  RuntimeEvent,
  UserDecisionOption,
  WorkSession,
} from "../shared/types.js";
import type { AiContinueContext, AiProvider, AiStartContext } from "./provider.js";

interface ProviderRuntimeEventResponse {
  events: ProviderEvent[];
}

type ProviderEvent =
  | { type: "work.activity"; message: string; metadata?: Record<string, unknown> }
  | { type: "artifact.updated"; artifact: ProviderArtifact }
  | { type: "ai.needs_user"; prompt: string; options?: UserDecisionOption[] }
  | { type: "work.completed"; summary?: string };

interface ProviderArtifact {
  title?: string;
  content: string;
  metadata?: Record<string, unknown>;
}

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
}

export class OpenAICompatibleProvider implements AiProvider {
  constructor(
    private readonly config: {
      baseUrl?: string;
      apiKey?: string;
      model?: string;
    },
  ) {}

  async *startWork(context: AiStartContext): AsyncIterable<RuntimeEvent> {
    this.assertConfigured();
    const response = await this.requestRuntimeEvents([
      { role: "system", content: systemPrompt() },
      { role: "user", content: startPrompt(context.session) },
    ]);
    yield* this.toRuntimeEvents(context.session, response);
  }

  async *continueWork(context: AiContinueContext): AsyncIterable<RuntimeEvent> {
    this.assertConfigured();
    const response = await this.requestRuntimeEvents([
      { role: "system", content: systemPrompt() },
      { role: "user", content: continuePrompt(context) },
    ]);
    yield* this.toRuntimeEvents(context.session, response);
  }

  private assertConfigured(): void {
    if (!this.config.baseUrl || !this.config.apiKey || !this.config.model) {
      throw new Error("AI provider requires INBETWEEN_AI_BASE_URL, INBETWEEN_AI_API_KEY, and INBETWEEN_AI_MODEL.");
    }
  }

  private async requestRuntimeEvents(messages: ChatMessage[]): Promise<ProviderRuntimeEventResponse> {
    const baseUrl = this.config.baseUrl!.replace(/\/$/, "");
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.config.model,
        messages,
        temperature: 0.4,
        response_format: { type: "json_object" },
      }),
    });

    const body = (await response.json()) as ChatCompletionResponse;
    if (!response.ok) {
      throw new Error(body.error?.message ?? `AI provider request failed with HTTP ${response.status}`);
    }

    const content = body.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("AI provider returned no message content.");
    }

    return parseProviderResponse(content);
  }

  private async *toRuntimeEvents(session: WorkSession, response: ProviderRuntimeEventResponse): AsyncIterable<RuntimeEvent> {
    for (const event of response.events) {
      const now = new Date().toISOString();
      if (event.type === "work.activity") {
        yield {
          id: createId("ai_event"),
          sessionId: session.id,
          type: "work.activity",
          createdAt: now,
          activity: {
            id: createId("activity"),
            sessionId: session.id,
            message: event.message,
            metadata: event.metadata,
            createdAt: now,
          },
        };
        continue;
      }

      if (event.type === "artifact.updated") {
        yield {
          id: createId("ai_event"),
          sessionId: session.id,
          type: "artifact.updated",
          createdAt: now,
          artifact: toWebsiteArtifact(session, event.artifact, now),
        };
        continue;
      }

      if (event.type === "ai.needs_user") {
        yield {
          id: createId("ai_event"),
          sessionId: session.id,
          type: "ai.needs_user",
          createdAt: now,
          decision: {
            id: createId("decision_request"),
            sessionId: session.id,
            prompt: event.prompt,
            options: event.options,
            required: true,
            createdAt: now,
          },
        };
        continue;
      }

      yield {
        id: createId("ai_event"),
        sessionId: session.id,
        type: "work.completed",
        createdAt: now,
        completion: {
          completedAt: now,
          summary: event.summary,
        },
      };
    }
  }
}

function toWebsiteArtifact(session: WorkSession, artifact: ProviderArtifact, now: string): Artifact {
  return {
    id: session.currentArtifact?.id ?? createId("artifact"),
    sessionId: session.id,
    kind: "website",
    version: (session.currentArtifact?.version ?? 0) + 1,
    title: artifact.title ?? "Landing Page",
    content: artifact.content,
    metadata: {
      taskType: "landing-page",
      format: "single-file-html",
      ...artifact.metadata,
    },
    createdAt: session.currentArtifact?.createdAt ?? now,
    updatedAt: now,
  };
}

function parseProviderResponse(content: string): ProviderRuntimeEventResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("AI provider returned invalid JSON runtime events.");
  }

  if (!isRuntimeEventResponse(parsed)) {
    throw new Error("AI provider response did not match the runtime event contract.");
  }

  return parsed;
}

function isRuntimeEventResponse(value: unknown): value is ProviderRuntimeEventResponse {
  if (!value || typeof value !== "object" || !Array.isArray((value as { events?: unknown }).events)) {
    return false;
  }

  return (value as ProviderRuntimeEventResponse).events.every((event) => {
    if (!event || typeof event !== "object" || typeof (event as { type?: unknown }).type !== "string") {
      return false;
    }
    if (event.type === "work.activity") {
      return typeof event.message === "string" && event.message.length > 0;
    }
    if (event.type === "artifact.updated") {
      return !!event.artifact && typeof event.artifact.content === "string" && event.artifact.content.length > 0;
    }
    if (event.type === "ai.needs_user") {
      return typeof event.prompt === "string" && event.prompt.length > 0;
    }
    if (event.type === "work.completed") {
      return true;
    }
    return false;
  });
}

function systemPrompt(): string {
  return `You are the first real AI provider for InBetween.
InBetween motto: "Stay in control while AI works."
You generate exactly one task type: website landing pages as single-file HTML artifacts.
Return only strict JSON with this shape:
{
  "events": [
    { "type": "work.activity", "message": "what you actually did" },
    { "type": "artifact.updated", "artifact": { "title": "...", "content": "complete single-file HTML", "metadata": { "decisionInfluence": "..." } } },
    { "type": "ai.needs_user", "prompt": "meaningful decision question", "options": [{ "id": "minimal", "label": "Minimal editorial", "description": "..." }] }
  ]
}
Allowed event types: work.activity, artifact.updated, ai.needs_user, work.completed.
For the first pass, do real planning and produce a useful HTML draft, then ask one meaningful style/content decision if it would improve the result.
After a user decision is provided, update the same artifact so the decision clearly influences the HTML, then emit work.completed.
Do not emit fake progress. Do not mention timers. Do not include markdown fences.`;
}

function startPrompt(session: WorkSession): string {
  return `Start this InBetween work session.
Session ID: ${session.id}
Task: ${session.task}

Create the first website landing-page artifact as complete single-file HTML. Then ask one genuine user decision needed to make the final artifact better.`;
}

function continuePrompt(context: AiContinueContext): string {
  return `Continue this InBetween work session after the user responded.
Session ID: ${context.session.id}
Task: ${context.session.task}
Current artifact:
${context.session.currentArtifact?.content ?? "No artifact yet."}

Pending decision prompt answered: ${context.decision.requestId}
User response: ${context.decision.response}
Selected option: ${context.decision.selectedOptionId ?? "none"}
Prior decisions: ${JSON.stringify(context.session.decisions)}

Update the website artifact so the user decision visibly influences it. Then complete the work.`;
}
