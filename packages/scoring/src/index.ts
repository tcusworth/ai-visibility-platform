import type { Observation, PromptDefinition, TargetEntity } from "@ai-visibility/domain";

export interface ScoringContext {
  observation: Observation;
  prompt: PromptDefinition;
  target: TargetEntity;
}

export interface ScoringResult {
  targetMentioned: boolean;
  targetCited: boolean;
  targetRecommended: boolean;
  targetPositioning: string;
  visibilityScore: number;
  weightedScore: number;
  scorerVersion: string;
}

export interface ObservationScorer {
  readonly version: string;
  score(context: ScoringContext): Promise<ScoringResult>;
}

export class DeterministicFakeScorer implements ObservationScorer {
  readonly version = "fake-deterministic-v1";

  async score(context: ScoringContext): Promise<ScoringResult> {
    if (context.observation.status !== "SUCCESS") {
      throw new Error("Only SUCCESS observations can be scored.");
    }

    const externalId = Number(context.prompt.externalPromptId);
    const seed = Number.isFinite(externalId)
      ? externalId
      : [...context.prompt.externalPromptId].reduce((sum, character) => sum + character.charCodeAt(0), 0);

    const targetMentioned = seed % 2 === 0;
    const targetCited = seed % 3 === 0;
    const visibilityScore = targetMentioned ? (targetCited ? 5 : 4) : targetCited ? 2 : 1;
    const targetRecommended = visibilityScore >= 4;

    return {
      targetMentioned,
      targetCited,
      targetRecommended,
      targetPositioning: targetRecommended
        ? `${context.target.canonicalName} is deterministically marked recommended for fake scoring validation.`
        : `${context.target.canonicalName} is deterministically marked not recommended for fake scoring validation.`,
      visibilityScore,
      weightedScore: visibilityScore * context.prompt.weight,
      scorerVersion: this.version,
    };
  }
}

export function applyScoringResult(observation: Observation, result: ScoringResult, updatedAt: string): Observation {
  return {
    ...observation,
    targetMentioned: result.targetMentioned,
    targetCited: result.targetCited,
    targetRecommended: result.targetRecommended,
    targetPositioning: result.targetPositioning,
    visibilityScore: result.visibilityScore,
    weightedScore: result.weightedScore,
    scorerVersion: result.scorerVersion,
    updatedAt,
  };
}

export * from "./methodology.js";
export * from "./snapshots.js";
