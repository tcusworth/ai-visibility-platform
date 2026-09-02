export type PlatformKey = "openai" | "anthropic" | "gemini" | "perplexity" | string;
export type ObservationStatus = "SUCCESS" | "FAILED";
export type RunStatus = "queued" | "running" | "finalizing" | "complete" | "incomplete" | "failed";
export type AuthoritySupportType = "NONE" | "OWN_ONLY" | "INDEPENDENT_ONLY" | "MIXED";

export interface Workspace {
  id: string;
  slug: string;
  name: string;
  timezone: string;
  active: boolean;
}

export interface TargetEntity {
  id: string;
  workspaceId: string;
  canonicalName: string;
  aliases: string[];
  ownedDomains: string[];
}

export interface CompetitorEntity {
  id: string;
  workspaceId: string;
  canonicalName: string;
  aliases: string[];
  domains: string[];
  active: boolean;
}

export interface PromptDefinition {
  id: string;
  externalPromptId: string;
  text: string;
  category: string;
  intent: string;
  weight: number;
  active: boolean;
}

export interface PromptSetVersion {
  id: string;
  workspaceId: string;
  name: string;
  version: string;
  prompts: PromptDefinition[];
}

export interface PlatformDefinition {
  key: PlatformKey;
  displayName: string;
  model: string;
  enabled: boolean;
}

export interface BenchmarkDefinition {
  id: string;
  workspaceId: string;
  targetEntityId: string;
  promptSetVersionId: string;
  scoringProfileVersion: string;
  authorityProfileVersion?: string;
  platforms: PlatformDefinition[];
  expectedPromptCount: number;
  active: boolean;
}

export interface BenchmarkRun {
  id: string;
  workspaceId: string;
  benchmarkDefinitionId: string;
  benchmarkRunKey: string;
  runDate: string;
  status: RunStatus;
  expectedPromptCount: number;
  expectedPlatformCount: number;
  expectedObservationCount: number;
  successfulObservationCount: number;
  failedObservationCount: number;
  comparisonEligible: boolean;
  methodologyVersion: string;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
}

export interface SourceReference {
  url: string;
  domain: string;
  ownedByTarget: boolean;
}

export interface EntityReference {
  canonicalName: string;
  type: "target" | "competitor" | "other";
}

export interface Observation {
  id: string;
  workspaceId: string;
  benchmarkRunId: string;
  benchmarkRunKey: string;
  promptId: string;
  platform: PlatformKey;
  model: string;
  status: ObservationStatus;
  answer?: string;
  errorCode?: string;
  errorMessage?: string;
  sources: SourceReference[];
  entities: EntityReference[];
  targetMentioned?: boolean;
  targetCited?: boolean;
  targetRecommended?: boolean;
  targetPositioning?: string;
  visibilityScore?: number;
  weightedScore?: number;
  scorerVersion: string;
  createdAt: string;
  updatedAt: string;
}

export interface AuthorityResult {
  observationId: string;
  classifierVersion: string;
  supportType: AuthoritySupportType;
  score: 0 | 1 | 2 | 3;
  qualifies: boolean;
  supportingDomains: string[];
  rationale?: string;
}

export function observationKey(input: Pick<Observation, "benchmarkRunKey" | "promptId" | "platform">): string {
  return `${input.benchmarkRunKey}|${input.promptId}|${input.platform}`;
}
