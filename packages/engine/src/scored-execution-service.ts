import { randomUUID } from "node:crypto";
import type { EntityReference, Observation, PromptDefinition, SourceReference, TargetEntity } from "@ai-visibility/domain";
import type { PersistObservationExecutionInput, PersistObservationExecutionResult } from "@ai-visibility/database";
import type { ScorerClient } from "@ai-visibility/providers";
import {
  buildVisibilityScorerPrompt,
  normalizeScorerClassification,
  type VisibilityScorerPromptProfile,
} from "@ai-visibility/scoring";

export interface ObservationExecutionPersistence {
  persist(input: PersistObservationExecutionInput): Promise<PersistObservationExecutionResult>;
}

export interface ScoredExecutionInput {
  workspaceId: string;
  benchmarkRunId: string;
  benchmarkRunKey: string;
  prompt: PromptDefinition;
  target: TargetEntity;
  platform: string;
  providerModel: string;
  providerAnswer: string;
  providerRequestId?: string;
  sources: SourceReference[];
  scorerPromptProfile: VisibilityScorerPromptProfile;
  recommendationThreshold?: number;
  startedAt?: string;
  completedAt?: string;
}

export interface ScoredExecutionResult {
  observation: Observation;
  persistence: PersistObservationExecutionResult;
  scorerModel: string;
  scorerResponseId?: string;
  parseFailed: boolean;
  notes: string;
}

export class ScoredExecutionFailureError extends Error {
  constructor(
    message: string,
    readonly observation: Observation,
    readonly persistence: PersistObservationExecutionResult,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ScoredExecutionFailureError";
  }
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase();
}

function mapScoredEntities(
  entities: Array<{ name: string; type: string }>,
  target: TargetEntity,
): EntityReference[] {
  const targetNames = new Set([
    target.canonicalName,
    ...target.aliases,
  ].map(normalizeName));

  return entities.map((entity) => ({
    canonicalName: entity.name,
    type: targetNames.has(normalizeName(entity.name)) ? "target" : "other",
  }));
}

export class ScoredObservationExecutionService {
  constructor(
    private readonly scorer: ScorerClient,
    private readonly persistence: ObservationExecutionPersistence,
  ) {}

  async execute(input: ScoredExecutionInput): Promise<ScoredExecutionResult> {
    if (!input.providerAnswer.trim()) throw new Error("Provider answer is required for scoring.");

    const sourceUrls = input.sources.map((source) => source.url);
    const sourceDomains = input.sources.map((source) => source.domain);
    const scorerPrompt = buildVisibilityScorerPrompt({
      profile: input.scorerPromptProfile,
      platform: input.platform,
      model: input.providerModel,
      prompt: input.prompt.text,
      answer: input.providerAnswer,
      sourceUrls,
      sourceDomains,
    });

    let scorerResponse;
    try {
      scorerResponse = await this.scorer.score({ prompt: scorerPrompt });
    } catch (error) {
      const now = input.completedAt ?? new Date().toISOString();
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
        errorCode: "SCORER_FAILURE",
        errorMessage: message,
        sources: input.sources,
        entities: [],
        scorerVersion: "scorer-failed",
        createdAt: now,
        updatedAt: now,
      };
      const persistence = await this.persistence.persist({
        observation,
        attempt: {
          status: "FAILED",
          ...(input.providerRequestId ? { providerRequestId: input.providerRequestId } : {}),
          errorCode: "SCORER_FAILURE",
          errorMessage: message,
          ...(input.startedAt ? { startedAt: input.startedAt } : {}),
          completedAt: now,
        },
      });
      throw new ScoredExecutionFailureError(
        `Scorer failed and the retryable FAILED observation was persisted: ${message}`,
        { ...observation, id: persistence.observationId },
        persistence,
        { cause: error },
      );
    }

    const scorerVersion = `${scorerResponse.model}:execution`;
    const normalized = normalizeScorerClassification({
      rawText: scorerResponse.rawText,
      sourceDomains,
      sourceUrls,
      ownedDomains: input.target.ownedDomains,
      promptWeight: input.prompt.weight,
      scorerVersion,
      ...(input.recommendationThreshold !== undefined
        ? { recommendationThreshold: input.recommendationThreshold }
        : {}),
    });

    const now = input.completedAt ?? new Date().toISOString();
    const observation: Observation = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      benchmarkRunId: input.benchmarkRunId,
      benchmarkRunKey: input.benchmarkRunKey,
      promptId: input.prompt.id,
      platform: input.platform,
      model: input.providerModel,
      status: "SUCCESS",
      answer: input.providerAnswer,
      sources: input.sources,
      entities: mapScoredEntities(normalized.entities, input.target),
      targetMentioned: normalized.targetMentioned,
      targetCited: normalized.targetCited,
      targetRecommended: normalized.targetRecommended,
      targetPositioning: normalized.targetPositioning,
      visibilityScore: normalized.visibilityScore,
      weightedScore: normalized.weightedScore,
      scorerVersion: normalized.scorerVersion,
      createdAt: now,
      updatedAt: now,
    };

    const persistence = await this.persistence.persist({
      observation,
      attempt: {
        status: "SUCCESS",
        ...(input.providerRequestId ? { providerRequestId: input.providerRequestId } : {}),
        ...(scorerResponse.responseId ? { rawResponseRef: `openai-response:${scorerResponse.responseId}` } : {}),
        ...(input.startedAt ? { startedAt: input.startedAt } : {}),
        completedAt: now,
      },
    });

    return {
      observation: { ...observation, id: persistence.observationId },
      persistence,
      scorerModel: scorerResponse.model,
      ...(scorerResponse.responseId ? { scorerResponseId: scorerResponse.responseId } : {}),
      parseFailed: normalized.parseFailed,
      notes: normalized.notes,
    };
  }
}
