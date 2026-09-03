import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  PostgresObservationExecutionStore,
  PostgresPlatformRepository,
} from "@ai-visibility/database";
import { BenchmarkObservationExecutionService } from "@ai-visibility/engine";
import {
  OpenAIResponsesScorerClient,
  type HttpJsonClient,
  type HttpJsonResponse,
} from "@ai-visibility/providers";
import type { PromptDefinition, TargetEntity } from "@ai-visibility/domain";
import {
  buildRunMetricSnapshot,
  type VisibilityMethodologyProfile,
  type VisibilityScorerPromptProfile,
} from "@ai-visibility/scoring";
import { createCsiProviderRegistry, CSI_PROVIDER_MODELS } from "./csi-provider-registry.js";

const platforms = ["openai", "gemini", "perplexity", "claude"] as const;
const MAX_PROMPTS = 5;
const MAX_OBSERVATIONS = MAX_PROMPTS * platforms.length;
const MAX_HTTP_REQUESTS = MAX_OBSERVATIONS * 2;

class CappedHttpClient implements HttpJsonClient {
  calls = 0;

  async postJson(url: string, headers: Record<string, string>, body: unknown): Promise<HttpJsonResponse> {
    this.calls += 1;
    if (this.calls > MAX_HTTP_REQUESTS) {
      throw new Error(`Shadow5 runner attempted more than ${MAX_HTTP_REQUESTS} HTTP requests.`);
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
    throw new Error("Shadow5 is restricted to local ai_visibility_dev.");
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

function methodologyProfile(): VisibilityMethodologyProfile {
  return {
    profileKey: "csi-production",
    version: "v1",
    recommendationThreshold: 4,
    primaryAuthorityThreshold: 5,
    providerSelectionIntent: "provider selection",
    successfulOnly: true,
    visibilityIndexWeights: {
      citationShare: 0.20,
      mentionShare: 0.30,
      recommendationShare: 0.30,
      weightedCommercialVisibility: 0.20,
    },
  };
}

function scorerProfile(): VisibilityScorerPromptProfile {
  return {
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
}

async function main(): Promise<void> {
  if (process.env.ALLOW_LIVE_SHADOW5 !== "YES") {
    throw new Error("Set ALLOW_LIVE_SHADOW5=YES to authorize the persistent five-prompt shadow run.");
  }
  if (process.env.ALLOW_LOCAL_DB_VALIDATION !== "YES") {
    throw new Error("Set ALLOW_LOCAL_DB_VALIDATION=YES to authorize local database writes.");
  }

  const runKey = requireEnv("SHADOW5_RUN_KEY");
  if (!/^\d{4}-\d{2}-\d{2}-shadow5-v1$/.test(runKey)) {
    throw new Error("SHADOW5_RUN_KEY must use YYYY-MM-DD-shadow5-v1.");
  }
  if (runKey === "2026-09-02-shadow-v1") {
    throw new Error("Refusing to use the existing 2026-09-02-shadow-v1 run key.");
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

  const pool = new Pool({ connectionString, ssl: false, max: 4 });
  const repository = new PostgresPlatformRepository(pool);
  const httpClient = new CappedHttpClient();

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
       WHERE prompt_set_version_id=$1
         AND active=true
         AND external_prompt_id IN ('1','2','3','4','5')
       ORDER BY external_prompt_id::int`,
      [def.prompt_set_version_id],
    );
    if (promptResult.rowCount !== MAX_PROMPTS) {
      throw new Error(`Expected prompts 1-5, found ${promptResult.rowCount ?? 0}.`);
    }

    const prompts: PromptDefinition[] = promptResult.rows.map((row) => ({
      id: String(row.id),
      externalPromptId: String(row.external_prompt_id),
      text: String(row.prompt_text),
      category: String(row.category),
      intent: String(row.intent),
      weight: Number(row.weight),
      active: Boolean(row.active),
    }));

    const existingRun = await pool.query(
      `SELECT id, benchmark_definition_id, expected_prompt_count, expected_platform_count, expected_observation_count
       FROM benchmark_runs WHERE workspace_id=$1 AND benchmark_run_key=$2 LIMIT 1`,
      [workspaceId, runKey],
    );

    let runId: string;
    if ((existingRun.rowCount ?? 0) > 0) {
      const row = existingRun.rows[0];
      if (String(row.benchmark_definition_id) !== def.id) {
        throw new Error("Existing Shadow5 run uses a different benchmark definition.");
      }
      if (Number(row.expected_prompt_count) !== MAX_PROMPTS ||
          Number(row.expected_platform_count) !== platforms.length ||
          Number(row.expected_observation_count) !== MAX_OBSERVATIONS) {
        throw new Error("Existing Shadow5 run has incompatible expected counts.");
      }
      runId = String(row.id);
      console.log(`Resuming existing Shadow5 run: ${runKey}`);
    } else {
      runId = randomUUID();
      await pool.query(
        `INSERT INTO benchmark_runs (
          id, workspace_id, benchmark_definition_id, benchmark_run_key, run_date, status,
          expected_prompt_count, expected_platform_count, expected_observation_count,
          successful_observation_count, failed_observation_count, comparison_eligible, methodology_version, started_at
         ) VALUES ($1,$2,$3,$4,$5,'running',$6,$7,$8,0,0,false,'csi-production-v1-shadow5',now())`,
        [
          runId,
          workspaceId,
          def.id,
          runKey,
          runKey.slice(0, 10),
          MAX_PROMPTS,
          platforms.length,
          MAX_OBSERVATIONS,
        ],
      );
      console.log(`Created persistent Shadow5 run: ${runKey}`);
    }

    const existing = await pool.query(
      `SELECT prompt_id, platform_key, status FROM observations WHERE benchmark_run_id=$1`,
      [runId],
    );
    const successfulKeys = new Set(
      existing.rows
        .filter((row) => row.status === "SUCCESS")
        .map((row) => `${String(row.prompt_id)}|${String(row.platform_key)}`),
    );

    const pending = prompts.flatMap((prompt) => platforms
      .filter((platform) => !successfulKeys.has(`${prompt.id}|${platform}`))
      .map((platform) => ({ prompt, platform })));

    console.log(`Run key: ${runKey}`);
    console.log(`Prompts selected: ${prompts.map((prompt) => prompt.externalPromptId).join(", ")}`);
    console.log(`Expected observations: ${MAX_OBSERVATIONS}`);
    console.log(`Already successful: ${successfulKeys.size}`);
    console.log(`Pending observations: ${pending.length}`);
    console.log(`Maximum HTTP requests this invocation: ${pending.length * 2}`);

    const registry = createCsiProviderRegistry(credentials, httpClient);
    const scorer = new OpenAIResponsesScorerClient({
      apiKey: credentials.openaiApiKey,
      model: scorerModel,
      httpClient,
    });
    const store = new PostgresObservationExecutionStore(pool);
    const scoreProfile = scorerProfile();

    for (const item of pending) {
      const provider = registry.get(item.platform);
      const service = new BenchmarkObservationExecutionService(provider, scorer, store);
      const providerPrompt = item.platform === "perplexity"
        ? item.prompt.text
        : benchmarkContext(item.prompt.text);

      console.log(`Executing prompt ${item.prompt.externalPromptId} on ${item.platform}...`);
      const result = await service.execute({
        workspaceId,
        benchmarkRunId: runId,
        benchmarkRunKey: runKey,
        prompt: item.prompt,
        target,
        platform: item.platform,
        providerModel: CSI_PROVIDER_MODELS[item.platform],
        providerPrompt,
        scorerPromptProfile: scoreProfile,
        recommendationThreshold: 4,
      });
      console.log(
        `  SUCCESS score=${result.scored.observation.visibilityScore}; mentioned=${result.scored.observation.targetMentioned}; ` +
        `cited=${result.scored.observation.targetCited}; recommended=${result.scored.observation.targetRecommended}; ` +
        `sources=${result.scored.observation.sources.length}; attempt=${result.scored.persistence.attempt.attemptNumber}`,
      );
    }

    if (httpClient.calls !== pending.length * 2) {
      throw new Error(`Expected ${pending.length * 2} HTTP requests for this invocation, observed ${httpClient.calls}.`);
    }

    const observations = await repository.listObservations(runId);
    const successCount = observations.filter((observation) => observation.status === "SUCCESS").length;
    const failedCount = observations.filter((observation) => observation.status === "FAILED").length;
    const logicalKeys = new Set(observations.map((observation) => `${observation.promptId}|${observation.platform}`));
    const complete = observations.length === MAX_OBSERVATIONS &&
      logicalKeys.size === MAX_OBSERVATIONS &&
      successCount === MAX_OBSERVATIONS &&
      failedCount === 0;

    await pool.query(
      `UPDATE benchmark_runs
       SET successful_observation_count=$2, failed_observation_count=$3, status=$4, comparison_eligible=false, updated_at=now()
       WHERE id=$1`,
      [runId, successCount, failedCount, complete ? "finalizing" : "running"],
    );

    console.log(`Canonical observations persisted: ${observations.length}`);
    console.log(`Logical observation keys: ${logicalKeys.size}`);
    console.log(`SUCCESS: ${successCount}`);
    console.log(`FAILED: ${failedCount}`);

    if (!complete) {
      throw new Error("Shadow5 is not complete; leave the persistent run in place for diagnosis and resume.");
    }

    const snapshot = buildRunMetricSnapshot({
      observations,
      prompts,
      platformOrder: [...platforms],
      profile: methodologyProfile(),
    });

    console.log(`Mention Share: ${(snapshot.mentionShare * 100).toFixed(1)}%`);
    console.log(`Citation Share: ${(snapshot.citationShare * 100).toFixed(1)}%`);
    console.log(`Recommendation Share: ${(snapshot.recommendationShare * 100).toFixed(1)}%`);
    console.log(`Visibility Index: ${snapshot.visibilityIndex}`);
    console.log(`Provider Selection Recommendation Share: ${(snapshot.providerSelectionRecommendationShare * 100).toFixed(1)}%`);
    for (const platform of snapshot.platforms) {
      console.log(`${platform.platform} Visibility Index: ${platform.visibilityIndex}`);
    }

    console.log("Persistent Shadow5 run completed successfully.");
    console.log("The run remains in local ai_visibility_dev for resume, lifecycle, source, attempt-history, and aggregation inspection.");
    console.log("No n8n, Google Sheets, or CSI production writes were made.");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
