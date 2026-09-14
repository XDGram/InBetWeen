import type { AiProvider } from "./provider.js";
import type { RuntimeEvent } from "../shared/types.js";

export class OpenAICompatibleProvider implements AiProvider {
  constructor(
    private readonly config: {
      baseUrl?: string;
      apiKey?: string;
      model?: string;
    },
  ) {}

  async *startWork(): AsyncIterable<RuntimeEvent> {
    this.assertConfigured();
    throw new Error("OpenAI-compatible runtime event streaming is not implemented yet.");
  }

  async *continueWork(): AsyncIterable<RuntimeEvent> {
    this.assertConfigured();
    throw new Error("OpenAI-compatible runtime event streaming is not implemented yet.");
  }

  private assertConfigured(): void {
    if (!this.config.baseUrl || !this.config.apiKey || !this.config.model) {
      throw new Error("AI provider requires INBETWEEN_AI_BASE_URL, INBETWEEN_AI_API_KEY, and INBETWEEN_AI_MODEL.");
    }
  }
}
