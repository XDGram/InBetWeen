export interface AiProviderConfig {
  provider: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}

export function loadAiProviderConfig(env: NodeJS.ProcessEnv = process.env): AiProviderConfig {
  return {
    provider: env.INBETWEEN_AI_PROVIDER ?? "openai-compatible",
    baseUrl: env.INBETWEEN_AI_BASE_URL,
    apiKey: env.INBETWEEN_AI_API_KEY,
    model: env.INBETWEEN_AI_MODEL,
  };
}
