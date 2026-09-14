import { loadAiProviderConfig } from "./config.js";
import { OpenAICompatibleProvider } from "./openAiCompatibleProvider.js";
import type { AiProvider } from "./provider.js";

export function createConfiguredAiProvider(env: NodeJS.ProcessEnv = process.env): AiProvider {
  const config = loadAiProviderConfig(env);

  if (config.provider !== "openai-compatible") {
    throw new Error(`Unsupported AI provider: ${config.provider}`);
  }

  return new OpenAICompatibleProvider(config);
}
