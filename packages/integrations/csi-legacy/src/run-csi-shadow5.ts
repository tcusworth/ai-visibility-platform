import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { PostgresObservationExecutionStore } from "@ai-visibility/database";
import { BenchmarkObservationExecutionService } from "@ai-visibility/engine";
import {
  OpenAIResponsesScorerClient,
  type HttpJsonClient,
  type HttpJsonResponse,
} from "@ai-visibility/providers";
import type { PromptDefinition, TargetEntity } from "@ai-visibility/domain";
import type { VisibilityScorerPromptProfile } from "@ai-visibility/scoring";
import { createCsiProviderRegistry, CSI_PROVIDER_MODELS } from "./csi-provider-registry.js";

const DEFAULT_RUN_KEY = "csi-shadow5-v1";
const METHODOLOGY_VERSION = "csi-shadow5-v1";
const PLATFORMS = ["openai", "gemini", "perplexity", "claude"] as const;
const EXPECTED_PROMPTS = 5;
const EXPECTED_OBSERVATIONS = EXPECTED_PROMPTS * PLATFORMS.length;
const MAX_HTTP_REQUESTS = EXPECTED_OBSERVATIONS * 2;

class GuardedHttpClient implements HttpJsonClient {
  calls = 0;

  async postJson(url: string, headers: Record<string, string>, body: unknown): Promise<HttpJsonResponse> {
    this.calls += 1;
    if (this.calls > MAX_HTTP_REQUESTS) {
      throw new Error(`CSI shadow5 runner attempted more than ${MAX_HTTP_REQUESTS} HTTP requests.`);
    }
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    return {
      ok: response.ok,
      status: response.status,
      json: async () => response.json() as Promise<unknown>,
    };
  }
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function requireLocalDb(value: string): void {
  const url = new URL(value);
  const database = url.pathname.replace(/^\//, "");
  if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname) || database !== "ai_visibility_dev") {
    throw new Error("CSI shadow5 execution is restricted to local ai_visibility_dev.");
  }
}

function benchmarkContext(question: string): string {
  return `You are answering a question specifically about industrial Open Process Automation (OPA) and the O-PAS™ Standard from The Open Group.

In this benchmark, OPA means Open Process Automation for industrial process control.

It does NOT mean Open Policy Agent or any unrelated use of the acronym OPA.

Do not use, cite, recommend, or rely on Open Policy Agent or openpolicyagent.org.

Answer the question as you normally would for an industrial automation professional.

Use web search when useful to identify relevant companies, organizations, integrators, suppliers, standards sources, technical resources, and practitioners.

Do not favor Collaborative Systems Integration (CSI), CSI Automation, csi-automation.com, or any other company simply because this is a benchmark. Recommendations and citations must arise naturally from the available web evidence.

Do not assume CSI should appear in the answer.

QUESTION:

${question}`;
}

async function main(): Promise<void> {
  if (process.env.ALLOW_LIVE_CSI_SHADOW5 !== "YES") {
    throw new Error(
      `Live CSI shadow5 execution blocked. Set ALLOW_LIVE_CSI_SHADOW5=YES to authorize up to ${MAX_HTTP_REQUESTS} external requests.`,
    );
  }
  if (process.env.ALLOW_LOCAL_DB_VALIDATION !== "YES") {
    throw new Error("Set ALLOW_LOCAL_DB_VALIDATION=YES to authorize persistent local shadow-run writes.");
  }

  const connectionString = requireEnv("DATABASE_URL");
  requireLocalDb(connectionString);

  const credentials = {
    openaiApiKey: requireEnv("OPENAI_API_KEY"),
    geminiApiKey: requireEnv("GEMINI_API_KEY"),
    perplexityApiKey: requireEnv("PERPLEXITY_API_KEY"),
    anthropicApiKey: requireEnv("ANTHROPIC_API_KEY"),
  };
  const scorerModel = process.env.SCORER_MODEL?.trim() || "gpt-5.4-nano";
  const runKey = process.env.CSI_SHADOW5_RUN_KEY?.trim() || DEFAULT_RUN_KEY;
  if (runKey === "2026-09-02-shadow-v1") {
    throw new Error("Refusing to use the existing 2026-09-02-shadow-v1 run key.");
  }

  const pool = new Pool({ connectionString, ssl: false, max: 4 });
  const httpClient = new GuardedHttpClient();

  try {
    const ws = await pool.query(`SELECT id FROM workspaces WHERE slug='csi-dev' AND active=true LIMIT 1`);
    const workspaceId = ws.rows[0]?.id as string | undefined;
    if (!workspaceId) throw new Error("Active csi-dev workspace not found.");

    const defResult = await pool.query(
      `SELECT id, target_entity_id, prompt_set_version_id FROM benchmark_definitions
       WHERE workspace_id=$1 AND active=true ORDER BY id LIMIT 1`,
      [workspaceId],
    );
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
      `SELECT id, external_prompt_id, prompt_text, category, intent, weight, active
       FROM prompts
       WHERE prompt_set_version_id=$1 AND active=true AND external_prompt_id IN ('1','2','3','4','5')
       ORDER BY external_prompt_id::int`,
      [def.prompt_set_version_id],
    );
    if (promptResult.rowCount !== EXPECTED_PROMPTS) {
      throw new Error(`Expected prompts 1-5, found ${promptResult.rowCount ?? 0}.`);
    }
    const prompts: PromptDefinition[] = promptResult.rows.map((row) => ({
      id: row.id,
      externalPromptId: row.external_prompt_id,
      text: row.prompt_text,
      category: row.category,
      intent: row.intent,
      weight: Number(row.weight),
      active: row.active,
    }));

    const existingRun = await pool.query(
      `SELECT id, benchmark_definition_id, expected_prompt_count, expected_platform_count, expected_observation_count
       FROM benchmark_runs WHERE workspace_id=$1 AND benchmark_run_key=$2 LIMIT 1`,
      [workspaceId, runKey],
    );

    let runId: string;
    if (existingRun.rows[0]) {
      const row = existingRun.rows[0];
      if (row.benchmark_definition_id !== def.id) throw new Error("Existing shadow5 run uses a different benchmark definition.");
      if (Number(row.expected_prompt_count) !== EXPECTED_PROMPTS ||
          Number(row.expected_platform_count) !== PLATFORMS.length ||
          Number(row.expected_observation_count) !== EXPECTED_OBSERVATIONS) {
        throw new Error("Existing shadow5 run has incompatible expected counts.");
      }
      runId = String(row.id);
      console.log(`Resuming persistent local run ${runKey}.`);
    } else {
      runId = randomUUID();
      await pool.query(
        `INSERT INTO benchmark_runs (
          id, workspace_id, benchmark_definition_id, benchmark_run_key, run_date, status,
          expected_prompt_count, expected_platform_count, expected_observation_count,
          successful_observation_count, failed_observation_count, comparison_eligible, methodology_version, started_at
         ) VALUES ($1,$2,$3,$4,CURRENT_DATE,'running',$5,$6,$7,0,0,false,$8,now())`,
        [runId, workspaceId, def.id, runKey, EXPECTED_PROMPTS, PLATFORMS.length, EXPECTED_OBSERVATIONS, METHODOLOGY_VERSION],
      );
      console.log(`Created persistent local run ${runKey}.`);
    }

    const profile: VisibilityScorerPromptProfile = {
      targetDisplayName: "Collaborative Systems Integration",
      targetShortName: "CSI",
      targetReferences: [
        "Collaborative Systems Integration",
        "CSI Automation",
        "csi-automation.com",
        "Collaborative Systems Integration (CSI)",
      ],
      mentionedField: "csi_mentioned",
      citedField: "csi_cited",
      positioningField: "csi_positioning",
      allowedEntityTypes: [
        "Integrator / Consultant",
        "Automation Vendor",
        "Technology Supplier",
        "Owner / Operator",
        "Standards / Industry Body",
        "Other",
      ],
      controlledSourceExample: "csi-automation.com",
    };

    const registry = createCsiProviderRegistry(credentials, httpClient);
    const scorer = new OpenAIResponsesScorerClient({
      apiKey: credentials.openaiApiKey,
      model: scorerModel,
      httpClient,
    });
    const store = new PostgresObservationExecutionStore(pool);

    let skippedSuccesses = 0;
    let attempted = 0;
    let executionFailures = 0;

    console.log(`Run key: ${runKey}`);
    console.log(`Prompts: ${prompts.map((item) => item.externalPromptId).join(", ")}`);
    console.log(`Platforms: ${PLATFORMS.join(", ")}`);
    console.log(`Maximum external requests this invocation: ${MAX_HTTP_REQUESTS}`);

    for (const prompt of prompts) {
      for (const platform of PLATFORMS) {
        const existing = await pool.query(
          `SELECT status FROM observations WHERE benchmark_run_id=$1 AND prompt_id=$2 AND platform_key=$3 LIMIT 1`,
          [runId, prompt.id, platform],
        );
        if (existing.rows[0]?.status === "SUCCESS") {
          skippedSuccesses += 1;
          console.log(`skip prompt ${prompt.externalPromptId} / ${platform}: already SUCCESS`);
          continue;
        }

        attempted += 1;
        const provider = registry.get(platform);
        const service = new BenchmarkObservationExecutionService(provider, scorer, store);
        const providerPrompt = platform === "perplexity" ? prompt.text : benchmarkContext(prompt.text);

        try {
          const result = await service.execute({
            workspaceId,
            benchmarkRunId: runId,
            benchmarkRunKey: runKey,
            prompt,
            target,
            platform,
            providerModel: CSI_PROVIDER_MODELS[platform],
            providerPrompt,
            scorerPromptProfile: profile,
            recommendationThreshold: 4,
          });
          console.log(
            `success prompt ${prompt.externalPromptId} / ${platform}: score=${result.scored.observation.visibilityScore}; ` +
            `mentioned=${result.scored.observation.targetMentioned}; cited=${result.scored.observation.targetCited}; ` +
            `recommended=${result.scored.observation.targetRecommended}; attempt=${result.scored.persistence.attempt.attemptNumber}`,
          );
        } catch (error) {
          executionFailures += 1;
          console.error(
            `failed prompt ${prompt.externalPromptId} / ${platform}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }

    const counts = await pool.query(
      `SELECT
         count(*) FILTER (WHERE status='SUCCESS')::int AS successful,
         count(*) FILTER (WHERE status='FAILED')::int AS failed,
         count(*)::int AS total
       FROM observations WHERE benchmark_run_id=$1`,
      [runId],
    );
    const successful = Number(counts.rows[0]?.successful ?? 0);
    const failed = Number(counts.rows[0]?.failed ?? 0);
    const total = Number(counts.rows[0]?.total ?? 0);
    const missing = EXPECTED_OBSERVATIONS - total;
    const complete = successful === EXPECTED_OBSERVATIONS && failed === 0 && missing === 0;

    await pool.query(
      `UPDATE benchmark_runs
       SET status=$2, successful_observation_count=$3, failed_observation_count=$4,
           comparison_eligible=false, updated_at=now()
       WHERE id=$1`,
      [runId, complete ? "finalizing" : "running", successful, failed],
    );

    console.log("--- shadow5 invocation summary ---");
    console.log(`Attempted observations: ${attempted}`);
    console.log(`Skipped existing SUCCESS observations: ${skippedSuccesses}`);
    console.log(`Execution failures this invocation: ${executionFailures}`);
    console.log(`HTTP requests made this invocation: ${httpClient.calls}`);
    console.log(`Canonical observations: ${total}/${EXPECTED_OBSERVATIONS}`);
    console.log(`SUCCESS: ${successful}`);
    console.log(`FAILED: ${failed}`);
    console.log(`Missing: ${missing}`);
    console.log(`Run status: ${complete ? "finalizing" : "running"}`);
    console.log("Persistent local run was retained for inspection and resume testing.");
    console.log("No n8n, Google Sheets, CSI production, or existing 2026-09-02-shadow-v1 records were touched.");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
