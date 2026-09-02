import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { PostgresObservationExecutionStore } from "@ai-visibility/database";
import { BenchmarkObservationExecutionService } from "@ai-visibility/engine";
import {
  PerplexityChatProvider,
  OpenAIResponsesScorerClient,
  type HttpJsonClient,
  type HttpJsonResponse,
} from "@ai-visibility/providers";
import type { PromptDefinition, TargetEntity } from "@ai-visibility/domain";
import type { VisibilityScorerPromptProfile } from "@ai-visibility/scoring";

class TwoRequestHttpClient implements HttpJsonClient {
  calls = 0;

  async postJson(url: string, headers: Record<string, string>, body: unknown): Promise<HttpJsonResponse> {
    this.calls += 1;
    if (this.calls > 2) throw new Error("Live Perplexity pipeline attempted more than two HTTP requests.");
    const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    return {
      ok: response.ok,
      status: response.status,
      json: async () => response.json() as Promise<unknown>,
    };
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
  console.log(`${message}: passed`);
}

function requireLocalDb(value: string): void {
  const url = new URL(value);
  if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname) || url.pathname.replace(/^\//, "") !== "ai_visibility_dev") {
    throw new Error("Live Perplexity pipeline validation is restricted to local ai_visibility_dev.");
  }
}

function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/^www\./, "").replace(/:\d+$/, "");
}

async function main(): Promise<void> {
  if (process.env.ALLOW_LIVE_PERPLEXITY_PIPELINE !== "YES") {
    throw new Error("Set ALLOW_LIVE_PERPLEXITY_PIPELINE=YES to authorize one Perplexity provider request and one OpenAI scorer request.");
  }
  if (process.env.ALLOW_LOCAL_DB_VALIDATION !== "YES") {
    throw new Error("Set ALLOW_LOCAL_DB_VALIDATION=YES to authorize temporary local database writes.");
  }

  const perplexityApiKey = process.env.PERPLEXITY_API_KEY?.trim();
  if (!perplexityApiKey) throw new Error("PERPLEXITY_API_KEY is required.");
  const openaiApiKey = process.env.OPENAI_API_KEY?.trim();
  if (!openaiApiKey) throw new Error("OPENAI_API_KEY is required.");
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) throw new Error("DATABASE_URL is required.");
  requireLocalDb(connectionString);

  const benchmarkModel = process.env.PERPLEXITY_BENCHMARK_MODEL?.trim() || "sonar";
  const scorerModel = process.env.SCORER_MODEL?.trim() || "gpt-5.4-nano";
  const pool = new Pool({ connectionString, ssl: false, max: 4 });
  const runId = randomUUID();
  const runKey = `live-perplexity-pipeline-validation-${randomUUID()}`;
  const httpClient = new TwoRequestHttpClient();

  try {
    const ws = await pool.query(`SELECT id FROM workspaces WHERE slug='csi-dev' AND active=true LIMIT 1`);
    const workspaceId = ws.rows[0]?.id as string | undefined;
    if (!workspaceId) throw new Error("Active csi-dev workspace not found.");

    const defResult = await pool.query(
      `SELECT id, target_entity_id, prompt_set_version_id FROM benchmark_definitions
       WHERE workspace_id=$1 AND active=true ORDER BY id LIMIT 1`, [workspaceId]);
    const def = defResult.rows[0] as { id: string; target_entity_id: string; prompt_set_version_id: string } | undefined;
    if (!def) throw new Error("Active benchmark definition not found.");

    const targetName = await pool.query(`SELECT canonical_name FROM target_entities WHERE id=$1`, [def.target_entity_id]);
    const aliases = await pool.query(`SELECT alias FROM target_aliases WHERE target_entity_id=$1 ORDER BY alias`, [def.target_entity_id]);
    const domains = await pool.query(`SELECT domain FROM owned_domains WHERE target_entity_id=$1 ORDER BY domain`, [def.target_entity_id]);
    const target: TargetEntity = {
      id: def.target_entity_id,
      workspaceId,
      canonicalName: String(targetName.rows[0]?.canonical_name),
      aliases: aliases.rows.map((row) => String(row.alias)),
      ownedDomains: domains.rows.map((row) => String(row.domain)),
    };

    const promptResult = await pool.query(
      `SELECT id, external_prompt_id, prompt_text, category, intent, weight, active FROM prompts
       WHERE prompt_set_version_id=$1 AND active=true ORDER BY external_prompt_id LIMIT 1`, [def.prompt_set_version_id]);
    const row = promptResult.rows[0];
    if (!row) throw new Error("Active prompt not found.");
    const prompt: PromptDefinition = {
      id: row.id,
      externalPromptId: row.external_prompt_id,
      text: row.prompt_text,
      category: row.category,
      intent: row.intent,
      weight: Number(row.weight),
      active: row.active,
    };

    await pool.query(
      `INSERT INTO benchmark_runs (
        id, workspace_id, benchmark_definition_id, benchmark_run_key, run_date, status,
        expected_prompt_count, expected_platform_count, expected_observation_count,
        successful_observation_count, failed_observation_count, comparison_eligible, methodology_version
       ) VALUES ($1,$2,$3,$4,CURRENT_DATE,'running',1,1,1,0,0,false,'live-perplexity-pipeline-validation-v1')`,
      [runId, workspaceId, def.id, runKey]);

    const profile: VisibilityScorerPromptProfile = {
      targetDisplayName: "Collaborative Systems Integration",
      targetShortName: "CSI",
      targetReferences: ["Collaborative Systems Integration", "CSI Automation", "csi-automation.com", "Collaborative Systems Integration (CSI)"],
      mentionedField: "csi_mentioned",
      citedField: "csi_cited",
      positioningField: "csi_positioning",
      allowedEntityTypes: ["Integrator / Consultant", "Automation Vendor", "Technology Supplier", "Owner / Operator", "Standards / Industry Body", "Other"],
      controlledSourceExample: "csi-automation.com",
    };

    const provider = new PerplexityChatProvider({ apiKey: perplexityApiKey, httpClient });
    const scorer = new OpenAIResponsesScorerClient({ apiKey: openaiApiKey, model: scorerModel, httpClient });
    const service = new BenchmarkObservationExecutionService(
      provider,
      scorer,
      new PostgresObservationExecutionStore(pool),
    );

    console.log(`Prompt external ID: ${prompt.externalPromptId}`);
    console.log(`Perplexity benchmark provider model requested: ${benchmarkModel}`);
    console.log(`OpenAI scorer model requested: ${scorerModel}`);
    console.log("Making exactly two HTTP requests: one Perplexity benchmark-provider request and one OpenAI scorer request...");

    const result = await service.execute({
      workspaceId,
      benchmarkRunId: runId,
      benchmarkRunKey: runKey,
      prompt,
      target,
      platform: "perplexity",
      providerModel: benchmarkModel,
      scorerPromptProfile: profile,
      recommendationThreshold: 4,
    });

    assert(httpClient.calls === 2, "Exactly two HTTP requests were made");
    assert(result.scored.observation.status === "SUCCESS", "Canonical observation persisted as SUCCESS");
    assert(result.scored.parseFailed === false, "Live scorer output parsed successfully");
    assert(result.scored.persistence.attempt.attemptNumber === 1, "Atomic attempt history contains attempt 1");
    assert(result.scored.observation.visibilityScore !== undefined && result.scored.observation.visibilityScore >= 0 && result.scored.observation.visibilityScore <= 5, "Visibility score is within production 0-5 range");
    assert(result.scored.observation.weightedScore === result.scored.observation.visibilityScore! * prompt.weight, "Weighted score equals visibility score × prompt weight");

    const owned = target.ownedDomains.map(normalizeDomain);
    for (const source of result.scored.observation.sources) {
      const domain = normalizeDomain(source.domain);
      const expectedOwned = owned.some((candidate) => domain === candidate || domain.endsWith(`.${candidate}`));
      assert(source.ownedByTarget === expectedOwned, `Source ownership normalized for ${source.domain}`);
    }

    const dbObservation = await pool.query(
      `SELECT id, status, target_mentioned, target_cited, target_recommended, visibility_score, weighted_score
       FROM observations WHERE benchmark_run_id=$1`, [runId]);
    assert(dbObservation.rowCount === 1, "Exactly one canonical database observation exists");

    const attempts = await pool.query(
      `SELECT attempt_number, status FROM observation_attempts WHERE observation_id=$1 ORDER BY attempt_number`,
      [result.scored.persistence.observationId]);
    assert(attempts.rowCount === 1 && attempts.rows[0]?.status === "SUCCESS", "Exactly one SUCCESS attempt-history row exists");

    console.log(`Perplexity provider response ID present: ${result.providerRequestId ? "yes" : "no"}`);
    console.log(`Perplexity provider model returned: ${result.scored.observation.model}`);
    console.log(`OpenAI scorer model returned: ${result.scored.scorerModel}`);
    console.log(`Answer length: ${result.scored.observation.answer?.length ?? 0} characters`);
    console.log(`Sources persisted: ${result.scored.observation.sources.length}`);
    console.log(`Target mentioned: ${result.scored.observation.targetMentioned}`);
    console.log(`Target cited: ${result.scored.observation.targetCited}`);
    console.log(`Visibility score: ${result.scored.observation.visibilityScore}`);
    console.log(`Target recommended: ${result.scored.observation.targetRecommended}`);
    console.log(`Weighted score: ${result.scored.observation.weightedScore}`);
    console.log("Live Perplexity end-to-end observation validation passed.");
    console.log("Exactly one Perplexity benchmark-provider request, one OpenAI scorer request, and temporary local database writes were made.");
    console.log("No n8n, Google Sheets, Gemini, Claude, or CSI production calls were made.");
  } finally {
    await pool.query(`DELETE FROM benchmark_runs WHERE id=$1`, [runId]).catch(() => undefined);
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
