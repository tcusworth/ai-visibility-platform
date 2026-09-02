import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { PostgresObservationExecutionStore } from "@ai-visibility/database";
import { ScoredObservationExecutionService } from "@ai-visibility/engine";
import {
  OpenAIResponsesScorerClient,
  type HttpJsonClient,
  type HttpJsonResponse,
} from "@ai-visibility/providers";
import type { PromptDefinition, TargetEntity } from "@ai-visibility/domain";
import type { VisibilityScorerPromptProfile } from "@ai-visibility/scoring";

class FetchHttpJsonClient implements HttpJsonClient {
  async postJson(url: string, headers: Record<string, string>, body: unknown): Promise<HttpJsonResponse> {
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

function requireLocalDevelopmentDatabase(connectionString: string): void {
  const url = new URL(connectionString);
  const localHosts = new Set(["localhost", "127.0.0.1", "::1"]);
  if (!localHosts.has(url.hostname) || url.pathname.replace(/^\//, "") !== "ai_visibility_dev") {
    throw new Error("Scored execution validation is restricted to the local ai_visibility_dev database.");
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
  console.log(`${message}: passed`);
}

async function main(): Promise<void> {
  if (process.env.ALLOW_LIVE_SCORER !== "YES") {
    throw new Error("Set ALLOW_LIVE_SCORER=YES to authorize exactly one scorer request.");
  }
  if (process.env.ALLOW_LOCAL_DB_VALIDATION !== "YES") {
    throw new Error("Set ALLOW_LOCAL_DB_VALIDATION=YES to authorize temporary local database writes.");
  }

  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error("OPENAI_API_KEY is required.");
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) throw new Error("DATABASE_URL is required.");
  requireLocalDevelopmentDatabase(connectionString);

  const scorerModel = process.env.SCORER_MODEL?.trim() || "gpt-5.4-nano";
  const pool = new Pool({ connectionString, ssl: false, max: 4 });
  const runId = randomUUID();
  const runKey = `scored-execution-validation-${randomUUID()}`;

  try {
    const workspaceResult = await pool.query(
      `SELECT id FROM workspaces WHERE slug='csi-dev' AND active=true LIMIT 1`,
    );
    const workspaceId = workspaceResult.rows[0]?.id as string | undefined;
    if (!workspaceId) throw new Error("Active csi-dev workspace not found.");

    const definitionResult = await pool.query(
      `SELECT id, target_entity_id, prompt_set_version_id
       FROM benchmark_definitions
       WHERE workspace_id=$1 AND active=true
       ORDER BY id LIMIT 1`,
      [workspaceId],
    );
    const definition = definitionResult.rows[0] as
      | { id: string; target_entity_id: string; prompt_set_version_id: string }
      | undefined;
    if (!definition) throw new Error("Active csi-dev benchmark definition not found.");

    const targetRow = await pool.query(
      `SELECT canonical_name FROM target_entities WHERE id=$1`,
      [definition.target_entity_id],
    );
    const aliasRows = await pool.query(
      `SELECT alias FROM target_aliases WHERE target_entity_id=$1 ORDER BY alias`,
      [definition.target_entity_id],
    );
    const domainRows = await pool.query(
      `SELECT domain FROM owned_domains WHERE target_entity_id=$1 ORDER BY domain`,
      [definition.target_entity_id],
    );
    const target: TargetEntity = {
      id: definition.target_entity_id,
      workspaceId,
      canonicalName: targetRow.rows[0]?.canonical_name as string,
      aliases: aliasRows.rows.map((row) => String(row.alias)),
      ownedDomains: domainRows.rows.map((row) => String(row.domain)),
    };

    const promptResult = await pool.query(
      `SELECT id, external_prompt_id, prompt_text, category, intent, weight, active
       FROM prompts
       WHERE prompt_set_version_id=$1 AND active=true
       ORDER BY external_prompt_id LIMIT 1`,
      [definition.prompt_set_version_id],
    );
    const row = promptResult.rows[0];
    if (!row) throw new Error("Active validation prompt not found.");
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
         successful_observation_count, failed_observation_count, comparison_eligible,
         methodology_version
       ) VALUES ($1,$2,$3,$4,CURRENT_DATE,'running',1,1,1,0,0,false,'scored-execution-validation-v1')`,
      [runId, workspaceId, definition.id, runKey],
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

    const scorer = new OpenAIResponsesScorerClient({
      apiKey,
      model: scorerModel,
      httpClient: new FetchHttpJsonClient(),
    });
    const store = new PostgresObservationExecutionStore(pool);
    const service = new ScoredObservationExecutionService(scorer, store);
    const now = new Date().toISOString();

    console.log(`Scorer model requested: ${scorerModel}`);
    console.log("Making exactly one scorer request through the execution service...");

    const result = await service.execute({
      workspaceId,
      benchmarkRunId: runId,
      benchmarkRunKey: runKey,
      prompt,
      target,
      platform: "openai",
      providerModel: "synthetic-provider-model",
      providerAnswer: "Collaborative Systems Integration (CSI) is one systems integrator to consider for O-PAS implementation work. The Open Group maintains the O-PAS standard.",
      providerRequestId: "synthetic-provider-request",
      sources: [
        {
          url: "https://csi-automation.com/open-process-automation",
          domain: "csi-automation.com",
          ownedByTarget: true,
        },
        {
          url: "https://www.opengroup.org/open-process-automation-forum",
          domain: "opengroup.org",
          ownedByTarget: false,
        },
      ],
      scorerPromptProfile: profile,
      recommendationThreshold: 4,
      startedAt: now,
      completedAt: now,
    });

    assert(result.observation.status === "SUCCESS", "Canonical observation persisted as SUCCESS");
    assert(result.observation.targetMentioned === true, "Target mention normalized through execution service");
    assert(result.observation.targetCited === true, "Owned-domain citation override preserved");
    assert(result.observation.visibilityScore === 4, "Production score 4 preserved");
    assert(result.observation.targetRecommended === true, "Recommendation threshold preserved");
    assert(result.observation.weightedScore === 4 * prompt.weight, "Weighted score preserved");
    assert(result.parseFailed === false, "Scorer output parsed successfully");
    assert(result.persistence.attempt.attemptNumber === 1, "Atomic attempt history created as attempt 1");

    const canonical = await pool.query(
      `SELECT status, target_mentioned, target_cited, target_recommended, visibility_score, weighted_score
       FROM observations WHERE id=$1`,
      [result.persistence.observationId],
    );
    assert(canonical.rowCount === 1, "Exactly one canonical database observation exists");

    const attempts = await pool.query(
      `SELECT attempt_number, status FROM observation_attempts WHERE observation_id=$1 ORDER BY attempt_number`,
      [result.persistence.observationId],
    );
    assert(attempts.rowCount === 1, "Exactly one attempt-history row exists");
    assert(attempts.rows[0]?.status === "SUCCESS", "Attempt history records SUCCESS");

    console.log(`Scorer model returned: ${result.scorerModel}`);
    console.log(`Scorer response ID present: ${result.scorerResponseId ? "yes" : "no"}`);
    console.log("Scored execution service validation passed.");
    console.log("Exactly one OpenAI scorer request and temporary local database writes were made.");
    console.log("No benchmark-provider, n8n, Google Sheets, or CSI production calls were made.");
  } finally {
    await pool.query(`DELETE FROM benchmark_runs WHERE id=$1`, [runId]).catch(() => undefined);
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
