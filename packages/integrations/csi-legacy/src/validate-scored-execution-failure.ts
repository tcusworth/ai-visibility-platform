import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { PostgresObservationExecutionStore } from "@ai-visibility/database";
import {
  ScoredExecutionFailureError,
  ScoredObservationExecutionService,
} from "@ai-visibility/engine";
import type { ScorerClient, ScorerResponse } from "@ai-visibility/providers";
import type { PromptDefinition, TargetEntity } from "@ai-visibility/domain";
import type { VisibilityScorerPromptProfile } from "@ai-visibility/scoring";

class FailOnceScorer implements ScorerClient {
  calls = 0;

  async score(): Promise<ScorerResponse> {
    this.calls += 1;
    if (this.calls === 1) throw new Error("Synthetic scorer outage.");
    return {
      rawText: JSON.stringify({
        csi_mentioned: true,
        csi_cited: false,
        visibility_score: 4,
        csi_positioning: "Synthetic successful retry.",
        entities: [],
        notes: "Synthetic scorer recovery.",
      }),
      model: "fake-recovery-scorer",
      responseId: "fake-response-2",
    };
  }
}

function requireLocalDevelopmentDatabase(connectionString: string): void {
  const url = new URL(connectionString);
  const localHosts = new Set(["localhost", "127.0.0.1", "::1"]);
  if (!localHosts.has(url.hostname) || url.pathname.replace(/^\//, "") !== "ai_visibility_dev") {
    throw new Error("Failure validation is restricted to the local ai_visibility_dev database.");
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
  console.log(`${message}: passed`);
}

async function main(): Promise<void> {
  if (process.env.ALLOW_LOCAL_DB_VALIDATION !== "YES") {
    throw new Error("Set ALLOW_LOCAL_DB_VALIDATION=YES to authorize temporary local database writes.");
  }
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) throw new Error("DATABASE_URL is required.");
  requireLocalDevelopmentDatabase(connectionString);

  const pool = new Pool({ connectionString, ssl: false, max: 4 });
  const runId = randomUUID();
  const runKey = `scored-execution-failure-validation-${randomUUID()}`;

  try {
    const workspaceResult = await pool.query(`SELECT id FROM workspaces WHERE slug='csi-dev' AND active=true LIMIT 1`);
    const workspaceId = workspaceResult.rows[0]?.id as string | undefined;
    if (!workspaceId) throw new Error("Active csi-dev workspace not found.");

    const definitionResult = await pool.query(
      `SELECT id, target_entity_id, prompt_set_version_id FROM benchmark_definitions
       WHERE workspace_id=$1 AND active=true ORDER BY id LIMIT 1`, [workspaceId]);
    const definition = definitionResult.rows[0] as { id: string; target_entity_id: string; prompt_set_version_id: string } | undefined;
    if (!definition) throw new Error("Active benchmark definition not found.");

    const targetRow = await pool.query(`SELECT canonical_name FROM target_entities WHERE id=$1`, [definition.target_entity_id]);
    const aliasRows = await pool.query(`SELECT alias FROM target_aliases WHERE target_entity_id=$1 ORDER BY alias`, [definition.target_entity_id]);
    const domainRows = await pool.query(`SELECT domain FROM owned_domains WHERE target_entity_id=$1 ORDER BY domain`, [definition.target_entity_id]);
    const target: TargetEntity = {
      id: definition.target_entity_id,
      workspaceId,
      canonicalName: String(targetRow.rows[0]?.canonical_name),
      aliases: aliasRows.rows.map((row) => String(row.alias)),
      ownedDomains: domainRows.rows.map((row) => String(row.domain)),
    };

    const promptResult = await pool.query(
      `SELECT id, external_prompt_id, prompt_text, category, intent, weight, active FROM prompts
       WHERE prompt_set_version_id=$1 AND active=true ORDER BY external_prompt_id LIMIT 1`, [definition.prompt_set_version_id]);
    const row = promptResult.rows[0];
    if (!row) throw new Error("Active prompt not found.");
    const prompt: PromptDefinition = {
      id: row.id, externalPromptId: row.external_prompt_id, text: row.prompt_text,
      category: row.category, intent: row.intent, weight: Number(row.weight), active: row.active,
    };

    await pool.query(
      `INSERT INTO benchmark_runs (
        id, workspace_id, benchmark_definition_id, benchmark_run_key, run_date, status,
        expected_prompt_count, expected_platform_count, expected_observation_count,
        successful_observation_count, failed_observation_count, comparison_eligible, methodology_version
       ) VALUES ($1,$2,$3,$4,CURRENT_DATE,'running',1,1,1,0,0,false,'failure-validation-v1')`,
      [runId, workspaceId, definition.id, runKey]);

    const profile: VisibilityScorerPromptProfile = {
      targetDisplayName: "Collaborative Systems Integration", targetShortName: "CSI",
      targetReferences: ["Collaborative Systems Integration", "CSI Automation", "csi-automation.com", "Collaborative Systems Integration (CSI)"],
      mentionedField: "csi_mentioned", citedField: "csi_cited", positioningField: "csi_positioning",
      allowedEntityTypes: ["Integrator / Consultant", "Automation Vendor", "Technology Supplier", "Owner / Operator", "Standards / Industry Body", "Other"],
      controlledSourceExample: "csi-automation.com",
    };

    const scorer = new FailOnceScorer();
    const service = new ScoredObservationExecutionService(scorer, new PostgresObservationExecutionStore(pool));
    const common = {
      workspaceId, benchmarkRunId: runId, benchmarkRunKey: runKey, prompt, target,
      platform: "openai", providerModel: "synthetic-provider-model",
      providerAnswer: "Collaborative Systems Integration (CSI) is one integrator to consider.",
      providerRequestId: "synthetic-provider-request",
      sources: [{ url: "https://csi-automation.com/test", domain: "csi-automation.com", ownedByTarget: true }],
      scorerPromptProfile: profile, recommendationThreshold: 4,
    };

    let failedId = "";
    try {
      await service.execute(common);
      throw new Error("Expected first scorer execution to fail.");
    } catch (error) {
      assert(error instanceof ScoredExecutionFailureError, "Scorer exception surfaced as ScoredExecutionFailureError");
      failedId = error.observation.id;
      assert(error.observation.status === "FAILED", "Canonical observation persisted as FAILED");
      assert(error.observation.errorCode === "SCORER_FAILURE", "FAILED observation records scorer failure code");
      assert(error.persistence.attempt.attemptNumber === 1, "FAILED scorer call persisted as attempt 1");
    }

    const failedRows = await pool.query(`SELECT id, status FROM observations WHERE benchmark_run_id=$1`, [runId]);
    assert(failedRows.rowCount === 1, "Exactly one canonical observation exists after scorer failure");
    assert(failedRows.rows[0]?.status === "FAILED", "Canonical database state is FAILED after scorer failure");

    const retry = await service.execute(common);
    assert(retry.observation.status === "SUCCESS", "Retry persisted as SUCCESS");
    assert(retry.persistence.observationId === failedId, "Retry reused the FAILED canonical observation row");
    assert(retry.persistence.attempt.attemptNumber === 2, "Successful retry persisted as attempt 2");
    assert(retry.observation.targetRecommended === true, "Successful retry was scored normally");

    const canonicalRows = await pool.query(`SELECT id, status, error_code, error_message FROM observations WHERE benchmark_run_id=$1`, [runId]);
    assert(canonicalRows.rowCount === 1, "Retry still leaves exactly one canonical observation");
    assert(canonicalRows.rows[0]?.status === "SUCCESS", "Canonical database state becomes SUCCESS after retry");
    assert(canonicalRows.rows[0]?.error_code === null && canonicalRows.rows[0]?.error_message === null, "Successful retry clears scorer failure fields");

    const attempts = await pool.query(
      `SELECT attempt_number, status, error_code FROM observation_attempts WHERE observation_id=$1 ORDER BY attempt_number`, [failedId]);
    assert(attempts.rowCount === 2, "Both scorer attempts are preserved in history");
    assert(attempts.rows[0]?.status === "FAILED" && attempts.rows[0]?.error_code === "SCORER_FAILURE", "Attempt 1 preserves scorer failure");
    assert(attempts.rows[1]?.status === "SUCCESS", "Attempt 2 preserves successful retry");
    assert(scorer.calls === 2, "Fake scorer was called exactly twice");

    console.log("Scored execution failure/retry validation passed.");
    console.log("Only a fake in-process scorer and the local ai_visibility_dev database were used.");
    console.log("No paid API, benchmark-provider, n8n, Google Sheets, or CSI production calls were made.");
  } finally {
    await pool.query(`DELETE FROM benchmark_runs WHERE id=$1`, [runId]).catch(() => undefined);
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
