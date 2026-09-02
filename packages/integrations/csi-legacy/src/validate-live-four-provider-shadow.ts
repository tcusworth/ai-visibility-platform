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

class EightRequestHttpClient implements HttpJsonClient {
  calls = 0;

  async postJson(url: string, headers: Record<string, string>, body: unknown): Promise<HttpJsonResponse> {
    this.calls += 1;
    if (this.calls > 8) {
      throw new Error("Four-provider shadow validator attempted more than eight HTTP requests.");
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

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
  console.log(`${message}: passed`);
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
    throw new Error("Four-provider shadow validation is restricted to local ai_visibility_dev.");
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
  if (process.env.ALLOW_LIVE_FOUR_PROVIDER_SHADOW !== "YES") {
    throw new Error(
      "Set ALLOW_LIVE_FOUR_PROVIDER_SHADOW=YES to authorize four provider requests and four OpenAI scorer requests.",
    );
  }
  if (process.env.ALLOW_LOCAL_DB_VALIDATION !== "YES") {
    throw new Error("Set ALLOW_LOCAL_DB_VALIDATION=YES to authorize temporary local database writes.");
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
  const runId = randomUUID();
  const runKey = `live-four-provider-shadow-${randomUUID()}`;
  const httpClient = new EightRequestHttpClient();

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
      `SELECT id, external_prompt_id, prompt_text, category, intent, weight, active FROM prompts
       WHERE prompt_set_version_id=$1 AND active=true ORDER BY external_prompt_id LIMIT 1`,
      [def.prompt_set_version_id],
    );
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
       ) VALUES ($1,$2,$3,$4,CURRENT_DATE,'running',1,4,4,0,0,false,'live-four-provider-shadow-v1')`,
      [runId, workspaceId, def.id, runKey],
    );

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
    const platforms = ["openai", "gemini", "perplexity", "claude"] as const;

    console.log(`Prompt external ID: ${prompt.externalPromptId}`);
    console.log(`OpenAI model: ${CSI_PROVIDER_MODELS.openai}`);
    console.log(`Gemini model: ${CSI_PROVIDER_MODELS.gemini}`);
    console.log(`Perplexity model: ${CSI_PROVIDER_MODELS.perplexity}`);
    console.log(`Claude model: ${CSI_PROVIDER_MODELS.claude}`);
    console.log(`OpenAI scorer model: ${scorerModel}`);
    console.log("Making exactly eight HTTP requests: four benchmark-provider requests and four OpenAI scorer requests...");

    for (const platform of platforms) {
      const provider = registry.get(platform);
      const service = new BenchmarkObservationExecutionService(provider, scorer, store);
      const providerPrompt = platform === "perplexity" ? prompt.text : benchmarkContext(prompt.text);
      const model = CSI_PROVIDER_MODELS[platform];

      const result = await service.execute({
        workspaceId,
        benchmarkRunId: runId,
        benchmarkRunKey: runKey,
        prompt,
        target,
        platform,
        providerModel: model,
        providerPrompt,
        scorerPromptProfile: profile,
        recommendationThreshold: 4,
      });

      assert(result.scored.observation.status === "SUCCESS", `${platform} canonical observation SUCCESS`);
      assert(result.scored.parseFailed === false, `${platform} scorer output parsed`);
      assert(result.scored.persistence.attempt.attemptNumber === 1, `${platform} attempt number is 1`);
      console.log(
        `${platform}: model=${result.scored.observation.model}; sources=${result.scored.observation.sources.length}; mentioned=${result.scored.observation.targetMentioned}; cited=${result.scored.observation.targetCited}; score=${result.scored.observation.visibilityScore}; recommended=${result.scored.observation.targetRecommended}`,
      );
    }

    assert(httpClient.calls === 8, "Exactly eight HTTP requests were made");

    const observations = await pool.query(
      `SELECT platform_key, status FROM observations WHERE benchmark_run_id=$1 ORDER BY platform_key`,
      [runId],
    );
    assert(observations.rowCount === 4, "Exactly four canonical observations exist");
    assert(observations.rows.every((item) => item.status === "SUCCESS"), "All four canonical observations are SUCCESS");
    assert(new Set(observations.rows.map((item) => String(item.platform_key))).size === 4, "All four platforms are represented exactly once");

    const attempts = await pool.query(
      `SELECT o.platform_key, a.attempt_number, a.status
       FROM observation_attempts a
       JOIN observations o ON o.id=a.observation_id
       WHERE o.benchmark_run_id=$1
       ORDER BY o.platform_key, a.attempt_number`,
      [runId],
    );
    assert(attempts.rowCount === 4, "Exactly four attempt-history rows exist");
    assert(attempts.rows.every((item) => item.attempt_number === 1 && item.status === "SUCCESS"), "Each platform has exactly one SUCCESS attempt 1");

    console.log("Four-provider orchestrated shadow validation passed.");
    console.log("One prompt was executed through OpenAI, Gemini, Perplexity, and Claude using the shared provider registry and shared persistence path.");
    console.log("Temporary local benchmark-run data will now be deleted.");
    console.log("No n8n, Google Sheets, CSI production, or existing shadow-run records were touched.");
  } finally {
    await pool.query(`DELETE FROM benchmark_runs WHERE id=$1`, [runId]).catch(() => undefined);
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
