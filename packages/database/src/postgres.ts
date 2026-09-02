import { Pool, type PoolConfig } from "pg";
import type {
  AuthorityResult,
  BenchmarkDefinition,
  BenchmarkRun,
  Observation,
  PlatformDefinition,
  PromptDefinition,
  PromptSetVersion,
  SourceReference,
  TargetEntity,
  Workspace,
} from "@ai-visibility/domain";
import type { MetricSnapshotRecord, PlatformRepository } from "./repository.js";

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value ?? "");
}

function dateOnly(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value ?? "").slice(0, 10);
}

function num(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nullableNum(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export class PostgresPlatformRepository implements PlatformRepository {
  readonly pool: Pool;

  constructor(config: PoolConfig | Pool) {
    this.pool = config instanceof Pool ? config : new Pool(config);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async getWorkspaceById(id: string): Promise<Workspace | null> {
    const result = await this.pool.query(
      `SELECT id, slug, name, timezone, active FROM workspaces WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row ? { id: row.id, slug: row.slug, name: row.name, timezone: row.timezone, active: row.active } : null;
  }

  async getWorkspaceBySlug(slug: string): Promise<Workspace | null> {
    const result = await this.pool.query(
      `SELECT id, slug, name, timezone, active FROM workspaces WHERE slug = $1`,
      [slug],
    );
    const row = result.rows[0];
    return row ? { id: row.id, slug: row.slug, name: row.name, timezone: row.timezone, active: row.active } : null;
  }

  async createWorkspace(workspace: Workspace): Promise<void> {
    await this.pool.query(
      `INSERT INTO workspaces (id, slug, name, timezone, active)
       VALUES ($1,$2,$3,$4,$5)`,
      [workspace.id, workspace.slug, workspace.name, workspace.timezone, workspace.active],
    );
  }

  async getTargetEntity(id: string): Promise<TargetEntity | null> {
    const targetResult = await this.pool.query(
      `SELECT id, workspace_id, canonical_name FROM target_entities WHERE id = $1`,
      [id],
    );
    const row = targetResult.rows[0];
    if (!row) return null;

    const [aliases, domains] = await Promise.all([
      this.pool.query(`SELECT alias FROM target_aliases WHERE target_entity_id = $1 ORDER BY alias`, [id]),
      this.pool.query(`SELECT domain FROM owned_domains WHERE target_entity_id = $1 ORDER BY domain`, [id]),
    ]);

    return {
      id: row.id,
      workspaceId: row.workspace_id,
      canonicalName: row.canonical_name,
      aliases: aliases.rows.map((item) => item.alias),
      ownedDomains: domains.rows.map((item) => item.domain),
    };
  }

  async getPromptSetVersion(id: string): Promise<PromptSetVersion | null> {
    const setResult = await this.pool.query(
      `SELECT id, workspace_id, name, version FROM prompt_set_versions WHERE id = $1`,
      [id],
    );
    const row = setResult.rows[0];
    if (!row) return null;

    const promptResult = await this.pool.query(
      `SELECT id, external_prompt_id, prompt_text, category, intent, weight, active
       FROM prompts WHERE prompt_set_version_id = $1 ORDER BY external_prompt_id`,
      [id],
    );

    const prompts: PromptDefinition[] = promptResult.rows.map((item) => ({
      id: item.id,
      externalPromptId: item.external_prompt_id,
      text: item.prompt_text,
      category: item.category,
      intent: item.intent,
      weight: num(item.weight),
      active: item.active,
    }));

    return { id: row.id, workspaceId: row.workspace_id, name: row.name, version: row.version, prompts };
  }

  async getBenchmarkDefinition(id: string): Promise<BenchmarkDefinition | null> {
    const definitionResult = await this.pool.query(
      `SELECT id, workspace_id, target_entity_id, prompt_set_version_id,
              scoring_profile_version, authority_profile_version,
              expected_prompt_count, active
       FROM benchmark_definitions WHERE id = $1`,
      [id],
    );
    const row = definitionResult.rows[0];
    if (!row) return null;

    const platformResult = await this.pool.query(
      `SELECT platform_key, display_name, model, enabled
       FROM benchmark_platforms WHERE benchmark_definition_id = $1 ORDER BY sort_order, platform_key`,
      [id],
    );

    const platforms: PlatformDefinition[] = platformResult.rows.map((item) => ({
      key: item.platform_key,
      displayName: item.display_name,
      model: item.model,
      enabled: item.enabled,
    }));

    return {
      id: row.id,
      workspaceId: row.workspace_id,
      targetEntityId: row.target_entity_id,
      promptSetVersionId: row.prompt_set_version_id,
      scoringProfileVersion: row.scoring_profile_version,
      ...(row.authority_profile_version ? { authorityProfileVersion: row.authority_profile_version } : {}),
      platforms,
      expectedPromptCount: row.expected_prompt_count,
      active: row.active,
    };
  }

  private mapRun(row: Record<string, any>): BenchmarkRun {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      benchmarkDefinitionId: row.benchmark_definition_id,
      benchmarkRunKey: row.benchmark_run_key,
      runDate: dateOnly(row.run_date),
      status: row.status,
      expectedPromptCount: row.expected_prompt_count,
      expectedPlatformCount: row.expected_platform_count,
      expectedObservationCount: row.expected_observation_count,
      successfulObservationCount: row.successful_observation_count,
      failedObservationCount: row.failed_observation_count,
      comparisonEligible: row.comparison_eligible,
      methodologyVersion: row.methodology_version,
      ...(row.started_at ? { startedAt: iso(row.started_at) } : {}),
      ...(row.completed_at ? { completedAt: iso(row.completed_at) } : {}),
      createdAt: iso(row.created_at),
    };
  }

  async getBenchmarkRunById(id: string): Promise<BenchmarkRun | null> {
    const result = await this.pool.query(`SELECT * FROM benchmark_runs WHERE id = $1`, [id]);
    return result.rows[0] ? this.mapRun(result.rows[0]) : null;
  }

  async getBenchmarkRunByKey(workspaceId: string, benchmarkRunKey: string): Promise<BenchmarkRun | null> {
    const result = await this.pool.query(
      `SELECT * FROM benchmark_runs WHERE workspace_id = $1 AND benchmark_run_key = $2`,
      [workspaceId, benchmarkRunKey],
    );
    return result.rows[0] ? this.mapRun(result.rows[0]) : null;
  }

  async createBenchmarkRun(run: BenchmarkRun): Promise<void> {
    await this.pool.query(
      `INSERT INTO benchmark_runs (
         id, workspace_id, benchmark_definition_id, benchmark_run_key, run_date, status,
         expected_prompt_count, expected_platform_count, expected_observation_count,
         successful_observation_count, failed_observation_count, comparison_eligible,
         methodology_version, started_at, completed_at, created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        run.id, run.workspaceId, run.benchmarkDefinitionId, run.benchmarkRunKey, run.runDate, run.status,
        run.expectedPromptCount, run.expectedPlatformCount, run.expectedObservationCount,
        run.successfulObservationCount, run.failedObservationCount, run.comparisonEligible,
        run.methodologyVersion, run.startedAt ?? null, run.completedAt ?? null, run.createdAt,
      ],
    );
  }

  async updateBenchmarkRun(run: BenchmarkRun): Promise<void> {
    await this.pool.query(
      `UPDATE benchmark_runs SET
         status=$2, successful_observation_count=$3, failed_observation_count=$4,
         comparison_eligible=$5, methodology_version=$6, started_at=$7, completed_at=$8,
         updated_at=now()
       WHERE id=$1`,
      [
        run.id, run.status, run.successfulObservationCount, run.failedObservationCount,
        run.comparisonEligible, run.methodologyVersion, run.startedAt ?? null, run.completedAt ?? null,
      ],
    );
  }

  async listCompleteRuns(workspaceId: string, limit = 20): Promise<BenchmarkRun[]> {
    const result = await this.pool.query(
      `SELECT * FROM benchmark_runs
       WHERE workspace_id=$1 AND status='complete' AND comparison_eligible=true
       ORDER BY run_date DESC, completed_at DESC NULLS LAST, created_at DESC
       LIMIT $2`,
      [workspaceId, limit],
    );
    return result.rows.map((row) => this.mapRun(row));
  }

  private async observationChildren(observationId: string): Promise<{ sources: SourceReference[]; entities: Observation["entities"] }> {
    const [sourceResult, entityResult] = await Promise.all([
      this.pool.query(
        `SELECT url, domain, owned_by_target FROM observation_sources WHERE observation_id=$1 ORDER BY source_order, id`,
        [observationId],
      ),
      this.pool.query(
        `SELECT canonical_name, entity_type FROM observation_entities WHERE observation_id=$1 ORDER BY id`,
        [observationId],
      ),
    ]);
    return {
      sources: sourceResult.rows.map((row) => ({ url: row.url, domain: row.domain, ownedByTarget: row.owned_by_target })),
      entities: entityResult.rows.map((row) => ({ canonicalName: row.canonical_name, type: row.entity_type })),
    };
  }

  private async mapObservation(row: Record<string, any>): Promise<Observation> {
    const children = await this.observationChildren(row.id);
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      benchmarkRunId: row.benchmark_run_id,
      benchmarkRunKey: row.benchmark_run_key,
      promptId: row.prompt_id,
      platform: row.platform_key,
      model: row.model,
      status: row.status,
      ...(row.answer_text !== null ? { answer: row.answer_text } : {}),
      ...(row.error_code ? { errorCode: row.error_code } : {}),
      ...(row.error_message ? { errorMessage: row.error_message } : {}),
      sources: children.sources,
      entities: children.entities,
      ...(row.target_mentioned !== null ? { targetMentioned: row.target_mentioned } : {}),
      ...(row.target_cited !== null ? { targetCited: row.target_cited } : {}),
      ...(row.target_recommended !== null ? { targetRecommended: row.target_recommended } : {}),
      ...(row.target_positioning ? { targetPositioning: row.target_positioning } : {}),
      ...(row.visibility_score !== null ? { visibilityScore: num(row.visibility_score) } : {}),
      ...(row.weighted_score !== null ? { weightedScore: num(row.weighted_score) } : {}),
      scorerVersion: row.scorer_version,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    };
  }

  async listObservations(benchmarkRunId: string): Promise<Observation[]> {
    const result = await this.pool.query(
      `SELECT * FROM observations WHERE benchmark_run_id=$1 ORDER BY prompt_id, platform_key`,
      [benchmarkRunId],
    );
    return Promise.all(result.rows.map((row) => this.mapObservation(row)));
  }

  async getObservation(benchmarkRunId: string, promptId: string, platform: string): Promise<Observation | null> {
    const result = await this.pool.query(
      `SELECT * FROM observations WHERE benchmark_run_id=$1 AND prompt_id=$2 AND platform_key=$3`,
      [benchmarkRunId, promptId, platform],
    );
    return result.rows[0] ? this.mapObservation(result.rows[0]) : null;
  }

  async upsertObservation(observation: Observation): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO observations (
           id, workspace_id, benchmark_run_id, benchmark_run_key, prompt_id, platform_key, model,
           status, answer_text, error_code, error_message, target_mentioned, target_cited,
           target_recommended, target_positioning, visibility_score, weighted_score, scorer_version,
           created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
         ON CONFLICT (benchmark_run_id, prompt_id, platform_key) DO UPDATE SET
           model=EXCLUDED.model, status=EXCLUDED.status, answer_text=EXCLUDED.answer_text,
           error_code=EXCLUDED.error_code, error_message=EXCLUDED.error_message,
           target_mentioned=EXCLUDED.target_mentioned, target_cited=EXCLUDED.target_cited,
           target_recommended=EXCLUDED.target_recommended, target_positioning=EXCLUDED.target_positioning,
           visibility_score=EXCLUDED.visibility_score, weighted_score=EXCLUDED.weighted_score,
           scorer_version=EXCLUDED.scorer_version, updated_at=EXCLUDED.updated_at`,
        [
          observation.id, observation.workspaceId, observation.benchmarkRunId, observation.benchmarkRunKey,
          observation.promptId, observation.platform, observation.model, observation.status,
          observation.answer ?? null, observation.errorCode ?? null, observation.errorMessage ?? null,
          observation.targetMentioned ?? null, observation.targetCited ?? null, observation.targetRecommended ?? null,
          observation.targetPositioning ?? null, observation.visibilityScore ?? null, observation.weightedScore ?? null,
          observation.scorerVersion, observation.createdAt, observation.updatedAt,
        ],
      );

      const idResult = await client.query(
        `SELECT id FROM observations WHERE benchmark_run_id=$1 AND prompt_id=$2 AND platform_key=$3`,
        [observation.benchmarkRunId, observation.promptId, observation.platform],
      );
      const observationId = idResult.rows[0].id as string;

      await client.query(`DELETE FROM observation_sources WHERE observation_id=$1`, [observationId]);
      for (let index = 0; index < observation.sources.length; index += 1) {
        const source = observation.sources[index]!;
        await client.query(
          `INSERT INTO observation_sources (observation_id, url, domain, owned_by_target, source_order)
           VALUES ($1,$2,$3,$4,$5)`,
          [observationId, source.url, source.domain, source.ownedByTarget, index],
        );
      }

      await client.query(`DELETE FROM observation_entities WHERE observation_id=$1`, [observationId]);
      for (const entity of observation.entities) {
        await client.query(
          `INSERT INTO observation_entities (observation_id, entity_type, canonical_name)
           VALUES ($1,$2,$3)`,
          [observationId, entity.type, entity.canonicalName],
        );
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listAuthorityResults(benchmarkRunId: string, classifierVersion?: string): Promise<AuthorityResult[]> {
    const params: unknown[] = [benchmarkRunId];
    const versionClause = classifierVersion ? ` AND ar.classifier_version=$2` : "";
    if (classifierVersion) params.push(classifierVersion);
    const result = await this.pool.query(
      `SELECT ar.observation_id, ar.classifier_version, ar.support_type, ar.score, ar.qualifies, ar.rationale,
              COALESCE(array_agg(ae.domain) FILTER (WHERE ae.domain IS NOT NULL), '{}') AS domains
       FROM authority_results ar
       JOIN observations o ON o.id=ar.observation_id
       LEFT JOIN authority_evidence ae ON ae.authority_result_id=ar.id
       WHERE o.benchmark_run_id=$1${versionClause}
       GROUP BY ar.id
       ORDER BY ar.observation_id`,
      params,
    );
    return result.rows.map((row) => ({
      observationId: row.observation_id,
      classifierVersion: row.classifier_version,
      supportType: row.support_type,
      score: row.score,
      qualifies: row.qualifies,
      supportingDomains: row.domains ?? [],
      ...(row.rationale ? { rationale: row.rationale } : {}),
    }));
  }

  async upsertAuthorityResult(result: AuthorityResult): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const saved = await client.query(
        `INSERT INTO authority_results (observation_id, classifier_version, support_type, score, qualifies, rationale)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (observation_id, classifier_version) DO UPDATE SET
           support_type=EXCLUDED.support_type, score=EXCLUDED.score,
           qualifies=EXCLUDED.qualifies, rationale=EXCLUDED.rationale, updated_at=now()
         RETURNING id`,
        [result.observationId, result.classifierVersion, result.supportType, result.score, result.qualifies, result.rationale ?? null],
      );
      const authorityResultId = saved.rows[0].id as string;
      await client.query(`DELETE FROM authority_evidence WHERE authority_result_id=$1`, [authorityResultId]);
      for (const domain of [...new Set(result.supportingDomains)]) {
        await client.query(
          `INSERT INTO authority_evidence (authority_result_id, domain) VALUES ($1,$2)`,
          [authorityResultId, domain],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async replaceMetricSnapshots(benchmarkRunId: string, snapshots: MetricSnapshotRecord[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`DELETE FROM metric_snapshots WHERE benchmark_run_id=$1`, [benchmarkRunId]);
      for (const item of snapshots) {
        await client.query(
          `INSERT INTO metric_snapshots (
             id, workspace_id, benchmark_run_id, metric_key, scope_type, scope_key,
             value, numerator, denominator, methodology_version, created_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            item.id, item.workspaceId, item.benchmarkRunId, item.metricKey, item.scopeType, item.scopeKey,
            item.value, item.numerator, item.denominator, item.methodologyVersion, item.createdAt,
          ],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listMetricSnapshots(benchmarkRunId: string): Promise<MetricSnapshotRecord[]> {
    const result = await this.pool.query(
      `SELECT * FROM metric_snapshots WHERE benchmark_run_id=$1 ORDER BY metric_key, scope_type, scope_key`,
      [benchmarkRunId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      workspaceId: row.workspace_id,
      benchmarkRunId: row.benchmark_run_id,
      metricKey: row.metric_key,
      scopeType: row.scope_type,
      scopeKey: row.scope_key,
      value: nullableNum(row.value),
      numerator: nullableNum(row.numerator),
      denominator: nullableNum(row.denominator),
      methodologyVersion: row.methodology_version,
      createdAt: iso(row.created_at),
    }));
  }
}

export function createPostgresRepositoryFromEnv(): PostgresPlatformRepository {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) throw new Error("DATABASE_URL is required.");
  return new PostgresPlatformRepository({
    connectionString,
    ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
    max: Number(process.env.DATABASE_POOL_MAX ?? 10),
  });
}
