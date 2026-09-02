import { observationKey, type Observation, type PlatformDefinition, type PromptDefinition } from "@ai-visibility/domain";

export * from "./run-initializer.js";

export interface PlannedObservation {
  prompt: PromptDefinition;
  platform: PlatformDefinition;
  observationKey: string;
}

export function dedupeObservations(observations: readonly Observation[]): Observation[] {
  const logical = new Map<string, Observation>();
  for (const observation of observations) logical.set(observationKey(observation), observation);
  return [...logical.values()];
}

export function planPendingObservations(input: {
  benchmarkRunKey: string;
  prompts: readonly PromptDefinition[];
  platforms: readonly PlatformDefinition[];
  existingObservations: readonly Observation[];
}): PlannedObservation[] {
  const successful = new Set(
    dedupeObservations(input.existingObservations)
      .filter((observation) => observation.status === "SUCCESS")
      .map(observationKey),
  );

  const planned: PlannedObservation[] = [];
  for (const prompt of input.prompts.filter((item) => item.active)) {
    for (const platform of input.platforms.filter((item) => item.enabled)) {
      const key = `${input.benchmarkRunKey}|${prompt.id}|${platform.key}`;
      if (!successful.has(key)) planned.push({ prompt, platform, observationKey: key });
    }
  }
  return planned;
}

export interface CompletenessResult {
  complete: boolean;
  expectedLogicalObservations: number;
  successfulLogicalObservations: number;
  failedLogicalObservations: number;
  missingObservationKeys: string[];
}

export function evaluateCompleteness(input: {
  benchmarkRunKey: string;
  prompts: readonly PromptDefinition[];
  platforms: readonly PlatformDefinition[];
  observations: readonly Observation[];
}): CompletenessResult {
  const logical = new Map(
    dedupeObservations(input.observations)
      .filter((observation) => observation.benchmarkRunKey === input.benchmarkRunKey)
      .map((observation) => [observationKey(observation), observation]),
  );

  const expectedKeys: string[] = [];
  for (const prompt of input.prompts.filter((item) => item.active)) {
    for (const platform of input.platforms.filter((item) => item.enabled)) {
      expectedKeys.push(`${input.benchmarkRunKey}|${prompt.id}|${platform.key}`);
    }
  }

  const expected = expectedKeys.map((key) => logical.get(key));
  const successful = expected.filter((item) => item?.status === "SUCCESS").length;
  const failed = expected.filter((item) => item?.status === "FAILED").length;
  const missing = expectedKeys.filter((key) => !logical.has(key));

  return {
    complete: missing.length === 0 && failed === 0 && successful === expectedKeys.length,
    expectedLogicalObservations: expectedKeys.length,
    successfulLogicalObservations: successful,
    failedLogicalObservations: failed,
    missingObservationKeys: missing,
  };
}
