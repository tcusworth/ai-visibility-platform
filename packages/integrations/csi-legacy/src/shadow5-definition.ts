import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { PlatformDefinition, PromptDefinition } from "@ai-visibility/domain";
import { CSI_PROVIDER_MODELS } from "./csi-provider-registry.js";

export const SHADOW5_PROMPT_EXTERNAL_IDS = ["1", "2", "3", "4", "5"] as const;
export const SHADOW5_PLATFORMS = ["openai", "gemini", "perplexity", "claude"] as const;
export const SHADOW5_PROMPT_SET_NAME = "CSI Persistent Shadow5";
export const SHADOW5_PROMPT_SET_VERSION = "v1";

interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}

export interface CsiShadow5Source {
  sourceDefinitionId: string;
  targetEntityId: string;
  scoringProfileVersion: string;
  authorityProfileVersion?: string;
  prompts: PromptDefinition[];
  platforms: PlatformDefinition[];
}

export interface CsiShadow5Definition {
  definitionId: string;
  promptSetVersionId: string;
  sourceDefinitionId: string;
  targetEntityId: string;
}

function assertShadow5Platforms(platforms: PlatformDefinition[]): void {
  if (platforms.length !== SHADOW5_PLATFORMS.length) {
    throw new Error(`Shadow5 requires exactly ${SHADOW5_PLATFORMS.length} enabled providers; found ${platforms.length}.`);
  }

  const byKey = new Map(platforms.map((platform) => [platform.key, platform]));
  for (const key of SHADOW5_PLATFORMS) {
    const platform = byKey.get(key);
    if (!platform?.enabled) throw new Error(`Shadow5 provider ${key} is not enabled in the CSI source definition.`);
    if (platform.model !== CSI_PROVIDER_MODELS[key]) {
      throw new Error(
        `Shadow5 model mismatch for ${key}: definition has ${platform.model}, registry expects ${CSI_PROVIDER_MODELS[key]}.`,
      );
    }
  }
}

async function loadCsiShadow5SourceFrom(queryable: Queryable, workspaceId: string): Promise<CsiShadow5Source> {
  const definitionResult = await queryable.query(
    `SELECT bd.id, bd.target_entity_id, bd.scoring_profile_version, bd.authority_profile_version
     FROM benchmark_definitions bd
     JOIN prompt_set_versions psv ON psv.id=bd.prompt_set_version_id
     WHERE bd.workspace_id=$1
       AND bd.active=true
       AND NOT (psv.name=$2 AND psv.version=$3)
       AND bd.expected_prompt_count >= $4
     ORDER BY bd.expected_prompt_count DESC, bd.created_at DESC
     LIMIT 1`,
    [workspaceId, SHADOW5_PROMPT_SET_NAME, SHADOW5_PROMPT_SET_VERSION, SHADOW5_PROMPT_EXTERNAL_IDS.length],
  );
  const definition = definitionResult.rows[0] as {
    id: string;
    target_entity_id: string;
    scoring_profile_version: string;
    authority_profile_version: string | null;
  } | undefined;
  if (!definition) throw new Error("Active CSI source benchmark definition not found for Shadow5.");

  const promptResult = await queryable.query(
    `SELECT p.id, p.external_prompt_id, p.prompt_text, p.category, p.intent, p.weight, p.active
     FROM prompts p
     JOIN benchmark_definitions bd ON bd.prompt_set_version_id=p.prompt_set_version_id
     WHERE bd.id=$1
       AND p.active=true
       AND p.external_prompt_id = ANY($2::text[])
     ORDER BY p.external_prompt_id::int`,
    [definition.id, [...SHADOW5_PROMPT_EXTERNAL_IDS]],
  );
  if ((promptResult.rowCount ?? 0) !== SHADOW5_PROMPT_EXTERNAL_IDS.length) {
    throw new Error(
      `Shadow5 source definition must contain active prompts ${SHADOW5_PROMPT_EXTERNAL_IDS.join(", ")}; found ${promptResult.rowCount ?? 0}.`,
    );
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

  if (prompts.map((prompt) => prompt.externalPromptId).join(",") !== SHADOW5_PROMPT_EXTERNAL_IDS.join(",")) {
    throw new Error("Shadow5 source prompt IDs are not exactly 1-5.");
  }

  const platformResult = await queryable.query(
    `SELECT platform_key, display_name, model, enabled
     FROM benchmark_platforms
     WHERE benchmark_definition_id=$1
       AND enabled=true
       AND platform_key = ANY($2::text[])
     ORDER BY sort_order, platform_key`,
    [definition.id, [...SHADOW5_PLATFORMS]],
  );
  const platforms: PlatformDefinition[] = platformResult.rows.map((row) => ({
    key: String(row.platform_key),
    displayName: String(row.display_name),
    model: String(row.model),
    enabled: Boolean(row.enabled),
  }));
  assertShadow5Platforms(platforms);

  return {
    sourceDefinitionId: definition.id,
    targetEntityId: definition.target_entity_id,
    scoringProfileVersion: definition.scoring_profile_version,
    ...(definition.authority_profile_version
      ? { authorityProfileVersion: definition.authority_profile_version }
      : {}),
    prompts,
    platforms,
  };
}

export async function loadCsiShadow5Source(pool: Pool, workspaceId: string): Promise<CsiShadow5Source> {
  return loadCsiShadow5SourceFrom(pool, workspaceId);
}

function assertPromptCopy(actual: PromptDefinition[], source: PromptDefinition[]): void {
  if (actual.length !== source.length) {
    throw new Error(`Existing Shadow5 prompt set has ${actual.length} prompts; expected ${source.length}.`);
  }
  const sourceByExternalId = new Map(source.map((prompt) => [prompt.externalPromptId, prompt]));
  for (const prompt of actual) {
    const expected = sourceByExternalId.get(prompt.externalPromptId);
    if (!expected) throw new Error(`Unexpected prompt ${prompt.externalPromptId} in existing Shadow5 prompt set.`);
    if (
      prompt.text !== expected.text ||
      prompt.category !== expected.category ||
      prompt.intent !== expected.intent ||
      prompt.weight !== expected.weight ||
      prompt.active !== true
    ) {
      throw new Error(`Existing Shadow5 prompt ${prompt.externalPromptId} no longer matches the CSI source prompt.`);
    }
  }
}

export async function ensureCsiShadow5Definition(pool: Pool, workspaceId: string): Promise<CsiShadow5Definition> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query("BEGIN");
    const source = await loadCsiShadow5SourceFrom(client, workspaceId);

    const promptSetResult = await client.query(
      `SELECT id FROM prompt_set_versions WHERE workspace_id=$1 AND name=$2 AND version=$3 LIMIT 1`,
      [workspaceId, SHADOW5_PROMPT_SET_NAME, SHADOW5_PROMPT_SET_VERSION],
    );
    let promptSetVersionId = promptSetResult.rows[0]?.id as string | undefined;
    if (!promptSetVersionId) {
      promptSetVersionId = randomUUID();
      await client.query(
        `INSERT INTO prompt_set_versions (id, workspace_id, name, version) VALUES ($1,$2,$3,$4)`,
        [promptSetVersionId, workspaceId, SHADOW5_PROMPT_SET_NAME, SHADOW5_PROMPT_SET_VERSION],
      );
      for (const prompt of source.prompts) {
        await client.query(
          `INSERT INTO prompts (
             id, prompt_set_version_id, external_prompt_id, prompt_text, category, intent, weight, active
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,true)`,
          [
            randomUUID(),
            promptSetVersionId,
            prompt.externalPromptId,
            prompt.text,
            prompt.category,
            prompt.intent,
            prompt.weight,
          ],
        );
      }
    } else {
      const existingPromptResult = await client.query(
        `SELECT id, external_prompt_id, prompt_text, category, intent, weight, active
         FROM prompts WHERE prompt_set_version_id=$1 ORDER BY external_prompt_id::int`,
        [promptSetVersionId],
      );
      const existingPrompts: PromptDefinition[] = existingPromptResult.rows.map((row) => ({
        id: String(row.id),
        externalPromptId: String(row.external_prompt_id),
        text: String(row.prompt_text),
        category: String(row.category),
        intent: String(row.intent),
        weight: Number(row.weight),
        active: Boolean(row.active),
      }));
      assertPromptCopy(existingPrompts, source.prompts);
    }

    const definitionResult = await client.query(
      `SELECT id, scoring_profile_version, authority_profile_version, expected_prompt_count
       FROM benchmark_definitions
       WHERE workspace_id=$1 AND target_entity_id=$2 AND prompt_set_version_id=$3
       ORDER BY created_at
       LIMIT 1`,
      [workspaceId, source.targetEntityId, promptSetVersionId],
    );
    let definitionId = definitionResult.rows[0]?.id as string | undefined;
    if (!definitionId) {
      definitionId = randomUUID();
      await client.query(
        `INSERT INTO benchmark_definitions (
           id, workspace_id, target_entity_id, prompt_set_version_id,
           scoring_profile_version, authority_profile_version, expected_prompt_count, active
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,false)`,
        [
          definitionId,
          workspaceId,
          source.targetEntityId,
          promptSetVersionId,
          source.scoringProfileVersion,
          source.authorityProfileVersion ?? null,
          SHADOW5_PROMPT_EXTERNAL_IDS.length,
        ],
      );
    } else {
      const existing = definitionResult.rows[0];
      if (
        String(existing.scoring_profile_version) !== source.scoringProfileVersion ||
        (existing.authority_profile_version ?? null) !== (source.authorityProfileVersion ?? null) ||
        Number(existing.expected_prompt_count) !== SHADOW5_PROMPT_EXTERNAL_IDS.length
      ) {
        throw new Error("Existing Shadow5 benchmark definition does not match the CSI source methodology.");
      }
    }

    const platformResult = await client.query(
      `SELECT platform_key, display_name, model, enabled
       FROM benchmark_platforms WHERE benchmark_definition_id=$1 ORDER BY sort_order, platform_key`,
      [definitionId],
    );
    if ((platformResult.rowCount ?? 0) === 0) {
      const sourceByKey = new Map(source.platforms.map((platform) => [platform.key, platform]));
      for (let index = 0; index < SHADOW5_PLATFORMS.length; index += 1) {
        const key = SHADOW5_PLATFORMS[index]!;
        const platform = sourceByKey.get(key);
        if (!platform) throw new Error(`Source platform ${key} disappeared during Shadow5 provisioning.`);
        await client.query(
          `INSERT INTO benchmark_platforms (
             id, benchmark_definition_id, platform_key, display_name, model, enabled, sort_order
           ) VALUES ($1,$2,$3,$4,$5,true,$6)`,
          [randomUUID(), definitionId, key, platform.displayName, platform.model, index],
        );
      }
    } else {
      const existingPlatforms: PlatformDefinition[] = platformResult.rows.map((row) => ({
        key: String(row.platform_key),
        displayName: String(row.display_name),
        model: String(row.model),
        enabled: Boolean(row.enabled),
      }));
      assertShadow5Platforms(existingPlatforms);
    }

    await client.query("COMMIT");
    return {
      definitionId,
      promptSetVersionId,
      sourceDefinitionId: source.sourceDefinitionId,
      targetEntityId: source.targetEntityId,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
