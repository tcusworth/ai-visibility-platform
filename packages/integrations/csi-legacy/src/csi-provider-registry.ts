import {
  ClaudeMessagesProvider,
  GeminiInteractionsProvider,
  OpenAIResponsesProvider,
  PerplexityChatProvider,
  ProviderRegistry,
  type HttpJsonClient,
} from "@ai-visibility/providers";

export interface CsiProviderCredentials {
  openaiApiKey: string;
  geminiApiKey: string;
  perplexityApiKey: string;
  anthropicApiKey: string;
}

export interface CsiProviderModels {
  openai: string;
  gemini: string;
  perplexity: string;
  claude: string;
}

export const CSI_PROVIDER_MODELS: CsiProviderModels = {
  openai: "gpt-5.6-luna",
  gemini: "gemini-3.7-flash",
  perplexity: "sonar",
  claude: "claude-sonnet-4-6",
};

export function createCsiProviderRegistry(
  credentials: CsiProviderCredentials,
  httpClient: HttpJsonClient,
): ProviderRegistry {
  const registry = new ProviderRegistry();

  registry.register(new OpenAIResponsesProvider({
    apiKey: credentials.openaiApiKey,
    httpClient,
    webSearch: true,
  }));

  registry.register(new GeminiInteractionsProvider({
    apiKey: credentials.geminiApiKey,
    httpClient,
    googleSearch: true,
  }));

  registry.register(new PerplexityChatProvider({
    apiKey: credentials.perplexityApiKey,
    httpClient,
  }));

  registry.register(new ClaudeMessagesProvider({
    apiKey: credentials.anthropicApiKey,
    httpClient,
    anthropicVersion: "2023-06-01",
    maxTokens: 900,
    webSearchMaxUses: 2,
  }));

  return registry;
}
