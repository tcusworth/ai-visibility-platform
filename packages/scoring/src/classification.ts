export interface ScoredEntity {
  name: string;
  type: string;
}

export interface RawScorerClassification {
  targetMentioned: boolean;
  targetCited: boolean;
  visibilityScore: number;
  targetPositioning: string;
  entities: ScoredEntity[];
  notes: string;
  parseFailed: boolean;
}

export interface NormalizeScorerInput {
  rawText: string;
  sourceDomains: string[];
  sourceUrls: string[];
  ownedDomains: string[];
  promptWeight: number;
  scorerVersion: string;
  recommendationThreshold?: number;
}

export interface NormalizedScorerResult extends RawScorerClassification {
  targetRecommended: boolean;
  weightedScore: number;
  scorerVersion: string;
}

function stripCodeFence(value: string): string {
  return value
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
}

function clampVisibilityScore(value: unknown): number {
  const numeric = Number(value ?? 0);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(5, numeric));
}

function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/^www\./, "").replace(/:\d+$/, "");
}

function domainFromUrl(value: string): string | null {
  try {
    return normalizeDomain(new URL(value).hostname);
  } catch {
    return null;
  }
}

function isOwnedDomain(domain: string, ownedDomains: string[]): boolean {
  const normalized = normalizeDomain(domain);
  return ownedDomains.some((owned) => {
    const canonical = normalizeDomain(owned);
    return normalized === canonical || normalized.endsWith(`.${canonical}`);
  });
}

function ownedSourcePresent(input: NormalizeScorerInput): boolean {
  if (input.sourceDomains.some((domain) => isOwnedDomain(domain, input.ownedDomains))) return true;

  return input.sourceUrls.some((url) => {
    const domain = domainFromUrl(url);
    return domain !== null && isOwnedDomain(domain, input.ownedDomains);
  });
}

function normalizeEntities(value: unknown): ScoredEntity[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entity) => {
    if (!entity || typeof entity !== "object") return [];
    const candidate = entity as Record<string, unknown>;
    const name = String(candidate.name ?? "").trim();
    if (!name) return [];
    return [{ name, type: String(candidate.type ?? "Other").trim() || "Other" }];
  });
}

export function normalizeScorerClassification(input: NormalizeScorerInput): NormalizedScorerResult {
  const scoreText = stripCodeFence(input.rawText);
  let parsed: Record<string, unknown>;
  let parseFailed = false;
  let parseFailureNote = "";

  try {
    const value: unknown = JSON.parse(scoreText);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Scorer output is not a JSON object.");
    parsed = value as Record<string, unknown>;
  } catch (error) {
    parseFailed = true;
    const message = error instanceof Error ? error.message : String(error);
    parseFailureNote = `Scoring JSON parse failed: ${message} | Raw: ${scoreText.slice(0, 500)}`;
    parsed = {};
  }

  const visibilityScore = parseFailed ? 0 : clampVisibilityScore(parsed.visibility_score);
  const targetMentioned = parseFailed ? false : Boolean(parsed.target_mentioned ?? parsed.csi_mentioned);
  const scorerCited = parseFailed ? false : Boolean(parsed.target_cited ?? parsed.csi_cited);
  const targetCited = scorerCited || ownedSourcePresent(input);
  const targetPositioning = parseFailed ? "" : String(parsed.target_positioning ?? parsed.csi_positioning ?? "");
  const entities = parseFailed ? [] : normalizeEntities(parsed.entities);
  const notes = parseFailed ? parseFailureNote : String(parsed.notes ?? "");
  const recommendationThreshold = input.recommendationThreshold ?? 4;

  return {
    targetMentioned,
    targetCited,
    visibilityScore,
    targetPositioning,
    entities,
    notes,
    parseFailed,
    targetRecommended: visibilityScore >= recommendationThreshold,
    weightedScore: visibilityScore * input.promptWeight,
    scorerVersion: input.scorerVersion,
  };
}
