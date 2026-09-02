import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { PostgresObservationExecutionStore } from "@ai-visibility/database";
import {
  BenchmarkObservationExecutionService,
  ProviderExecutionFailureError,
} from "@ai-visibility/engine";
import type {
  ModelProvider,
  ProviderRequest,
  ProviderResponse,
  ScorerClient,
  ScorerResponse,
} from "@ai-visibility/providers";
import type { PromptDefinition, TargetEntity } from "@ai-visibility/domain";
import type { VisibilityScorerPromptProfile } from "@ai-visibility/scoring";

class FailOnceProvider implements ModelProvider {
  readonly platform = "openai";
  calls = 0;

  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    this.calls += 1;
    if (this.calls === 1) throw new Error("Synthetic provider outage.");
    return {
      answer: "Collaborative Systems Integration (CSI) is one integrator to consider.",
      model: request.model,
      rawProviderId: "fake-provider-success-2",
    };
  }
}

class CountingScorer implements ScorerClient {
  calls = 0;

  async score(): Promise<ScorerResponse> {
    this.calls += 1;
    return {
      rawText: JSON.stringify({
        csi_mentioned: true,
        csi_cited: false,
        visibility_score: 4,
        csi_positioning: "Synthetic provider retry success.",
        entities: [],
        notes: "Synthetic scorer result.",
      }),
      model: "fake-scorer",
      responseId: "fake-scorer-response-1",
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
    throw new Error("Provider failure validation is restricted to local ai_visibility_dev.");
  }
}

async function main(): Promise<void> {
  if (process.env.ALLOW_LOCAL_DB_VALIDATION !== "YES") throw new Error("Set ALLOW_LOCAL_DB_VALIDATION=YES.");
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) throw new Error("DATABASE_URL is required.");
  requireLocalDb(connectionString);

  const pool = new Pool({ connectionString, ssl: false, max: 4 });
  const runId = randomUUID();
  const runKey = `provider-failure-validation-${randomUUID()}`;

  try {
    const ws = await pool.query(`SELECT id FROM workspaces WHERE slug='csi-dev' AND active=true LIMIT 1`);
    const workspaceId = ws.rows[0]?.id as string | undefined;
    if (!workspaceId) throw new Error("Active csi-dev workspace not found.");

    const defResult = await pool.query(
      `SELECT id, target_entity_id, prompt_set_version_id FROM benchmark_definitions WHERE workspace_id=$1 AND active=true ORDER BY id LIMIT 1`,
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
      aliases: aliases.rows.map((r) => String(r.alias)),
      ownedDomains: domains.rows.map((r) => String(r.domain)),
    };

    const p = await pool.query(
      `SELECT id, external_prompt_id, prompt_text, category, intent, weight, active FROM prompts WHERE prompt_set_version_id=$1 AND active=true ORDER BY external_prompt_id LIMIT 1`,
      [def.prompt_set_version_id],
    );
    const row = p.rows[0];
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
      `INSERT INTO benchmark_runs (id, workspace_id, benchmark_definition_id, benchmark_run_key, run_date, status,
       expected_prompt_count, expected_platform_count, expected_observation_count, successful_observation_count,
       failed_observation_count, comparison_eligible, methodology_version)
       VALUES ($1,$2,$3,$4,CURRENT_DATE,'running',1,1,1,0,0,false,'provider-failure-validation-v1')`,
      [runId, workspaceId, def.id, runKey],
    );

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

    const provider = new FailOnceProvider();
    const scorer = new CountingScorer();
    const service = new BenchmarkObservationExecutionService(provider, scorer, new PostgresObservationExecutionStore(pool));
    const input = {
      workspaceId,
      benchmarkRunId: runId,
      benchmarkRunKey: runKey,
      prompt,
      target,
      platform: "openai",
      providerModel: "synthetic-provider-model",
      sources: [{ url: "https://csi-automation.com/test", domain: "csi-automation.com", ownedByTarget: true }],
      scorerPromptProfile: profile,
      recommendationThreshold: 4,
    };

    let failedId = "";
    try {
      await service.execute(input);
      throw new Error("Expected provider failure.");
    } catch (error) {
      assert(error instanceof ProviderExecutionFailureError, "Provider exception surfaced as ProviderExecutionFailureError");
      failedId = error.observation.id;
      assert(error.observation.status === "FAILED", "Provider failure persisted canonical FAILED observation");
      assert(error.observation.errorCode === "PROVIDER_FAILURE", "Provider failure code persisted");
      assert(error.persistence.attempt.attemptNumber === 1, "Provider failure persisted as attempt 1");
    }

    assert(scorer.calls === 0, "Scorer was not called after provider failure");

    const retry = await service.execute(input);
    assert(retry.scored.observation.status === "SUCCESS", "Provider retry completed as SUCCESS");
    assert(retry.scored.persistence.observationId === failedId, "Provider retry reused canonical FAILED row");
    assert(retry.scored.persistence.attempt.attemptNumber === 2, "Provider retry persisted as attempt 2");
    assert(provider.calls === 2, "Fake provider was called exactly twice");
    assert(scorer.calls === 1, "Scorer was called only for successful provider response");

    const observations = await pool.query(`SELECT id, status, error_code FROM observations WHERE benchmark_run_id=$1`, [runId]);
    assert(observations.rowCount === 1, "Exactly one canonical observation remains after retry");
    assert(observations.rows[0]?.status === "SUCCESS" && observations.rows[0]?.error_code === null, "Canonical state is clean SUCCESS after retry");

    const attempts = await pool.query(
      `SELECT attempt_number, status, error_code FROM observation_attempts WHERE observation_id=$1 ORDER BY attempt_number`,
      [failedId],
    );
    assert(attempts.rowCount === 2, "Both provider attempts are preserved");
    assert(attempts.rows[0]?.status === "FAILED" && attempts.rows[0]?.error_code === "PROVIDER_FAILURE", "Attempt 1 preserves provider failure");
    assert(attempts.rows[1]?.status === "SUCCESS", "Attempt 2 preserves successful retry");

    console.log("Provider failure/retry validation passed.");
    console.log("Only fake in-process provider/scorer components and local ai_visibility_dev were used.");
    console.log("No paid API, n8n, Google Sheets, or CSI production calls were made.");
  } finally {
    await pool.query(`DELETE FROM benchmark_runs WHERE id=$1`, [runId]).catch(() => undefined);
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
