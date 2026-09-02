import { randomUUID } from "node:crypto";
import type { Observation, PlatformKey, PromptDefinition, SourceReference, TargetEntity } from "@ai-visibility/domain";
import type { PersistObservationExecutionResult } from "@ai-visibility/database";
import type { ModelProvider, ScorerClient } from "@ai-visibility/providers";
import type { VisibilityScorerPromptProfile } from "@ai-visibility/scoring";
import {
  ScoredObservationExecutionService,
  type ObservationExecutionPersistence,
  type ScoredExecutionResult,
} from "./scored-execution-service.js";

export interface BenchmarkObservationExecutionInput {
  workspaceId: string;
  benchmarkRunId: string;
  benchmarkRunKey: string;
  prompt: PromptDefinition;
  target: TargetEntity;
  platform: PlatformKey;
  providerModel: string;
  sources?: SourceReference[];
  scorerPromptProfile: VisibilityScorerPromptProfile;
  recommendationThreshold?: number;
  startedAt?: string;
}

export interface BenchmarkObservationExecutionResult {
  providerRequestId?: string;
  scored: ScoredExecutionResult;
}

export class ProviderExecutionFailureError extends Error {
  constructor(
    message: string,
    readonly observation: Observation,
    readonly persistence: PersistObservationExecutionResult,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProviderExecutionFailureError";
  }
}

export class BenchmarkObservationExecutionService {
  private readonly scoredExecution: ScoredObservationExecutionService;

  constructor(
    private readonly provider: ModelProvider,
    scorer: ScorerClient,
    private readonly persistence: ObservationExecutionPersistence,
  ) {
    this.scoredExecution = new ScoredObservationExecutionService(scorer, persistence);
  }

  async execute(input: BenchmarkObservationExecutionInput): Promise<BenchmarkObservationExecutionResult> {
    if (this.provider.platform !== input.platform) {
      throw new Error(
        `Provider platform ${String(this.provider.platform)} does not match requested platform ${String(input.platform)}.`,
      );
    }

    const startedAt = input.startedAt ?? new Date().toISOString();
    let providerResponse;
    try {
      providerResponse = await this.provider.generate({
        platform: input.platform,
        model: input.providerModel,
        prompt: input.prompt.text,
      });
    } catch (error) {
      const completedAt = new Date().toISOString();
      const message = error instanceof Error ? error.message : String(error);
      const observation: Observation = {
        id: randomUUID(),
        workspaceId: input.workspaceId,
        benchmarkRunId: input.benchmarkRunId,
        benchmarkRunKey: input.benchmarkRunKey,
        promptId: input.prompt.id,
        platform: input.platform,
        model: input.providerModel,
        status: "FAILED",
        errorCode: "PROVIDER_FAILURE",
        errorMessage: message,
        sources: [],
        entities: [],
        scorerVersion: "not-scored-provider-failure",
        createdAt: completedAt,
        updatedAt: completedAt,
      };
      const persistence = await this.persistence.persist({
        observation,
        attempt: {
          status: "FAILED",
          errorCode: "PROVIDER_FAILURE",
          errorMessage: message,
          startedAt,
          completedAt,
        },
      });
      throw new ProviderExecutionFailureError(
        `Provider failed and the retryable FAILED observation was persisted: ${message}`,
        { ...observation, id: persistence.observationId },
        persistence,
        { cause: error },
      );
    }

    const scored = await this.scoredExecution.execute({
      workspaceId: input.workspaceId,
      benchmarkRunId: input.benchmarkRunId,
      benchmarkRunKey: input.benchmarkRunKey,
      prompt: input.prompt,
      target: input.target,
      platform: input.platform,
      providerModel: providerResponse.model,
      providerAnswer: providerResponse.answer,
      ...(providerResponse.rawProviderId ? { providerRequestId: providerResponse.rawProviderId } : {}),
      sources: input.sources ?? [],
      scorerPromptProfile: input.scorerPromptProfile,
      ...(input.recommendationThreshold !== undefined
        ? { recommendationThreshold: input.recommendationThreshold }
        : {}),
      startedAt,
      completedAt: new Date().toISOString(),
    });

    return {
      ...(providerResponse.rawProviderId ? { providerRequestId: providerResponse.rawProviderId } : {}),
      scored,
    };
  }
}
