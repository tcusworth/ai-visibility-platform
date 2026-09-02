import type { PlatformKey, SourceReference } from "@ai-visibility/domain";

export interface ProviderRequest {
  platform: PlatformKey;
  model: string;
  prompt: string;
}

export interface ProviderResponse {
  answer: string;
  model: string;
  rawProviderId?: string;
  sources?: SourceReference[];
}

export interface ModelProvider {
  readonly platform: PlatformKey;
  generate(request: ProviderRequest): Promise<ProviderResponse>;
}

export class FakeProvider implements ModelProvider {
  readonly platform: PlatformKey;

  constructor(platform: PlatformKey) {
    this.platform = platform;
  }

  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    if (request.platform !== this.platform) {
      throw new Error(`Fake provider for ${this.platform} cannot execute ${request.platform}.`);
    }

    return {
      answer: `[FAKE ${String(this.platform)} RESPONSE] ${request.prompt}`,
      model: request.model,
      rawProviderId: `fake:${String(this.platform)}`,
    };
  }
}

export class ProviderRegistry {
  private readonly providers = new Map<PlatformKey, ModelProvider>();

  register(provider: ModelProvider): void {
    this.providers.set(provider.platform, provider);
  }

  get(platform: PlatformKey): ModelProvider {
    const provider = this.providers.get(platform);
    if (!provider) throw new Error(`No provider registered for platform: ${String(platform)}`);
    return provider;
  }
}

export * from "./openai-scorer.js";
export * from "./openai-provider.js";
export * from "./gemini-provider.js";
export * from "./perplexity-provider.js";
