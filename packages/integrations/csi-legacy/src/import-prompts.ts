import fs from 'node:fs/promises';
import process from 'node:process';
import pg from 'pg';

const { Pool } = pg;

interface CsvRow {
  prompt_id: string;
  prompt: string;
  category: string;
  intent: string;
  weight: string;
  active: string;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];

    if (ch === '"') {
      if (quoted && next === '"') {
        field += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }

    if (ch === ',' && !quoted) {
      row.push(field);
      field = '';
      continue;
    }

    if ((ch === '\n' || ch === '\r') && !quoted) {
      if (ch === '\r' && next === '\n') i += 1;
      row.push(field);
      field = '';
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
      continue;
    }

    field += ch;
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase();
}

function parseBoolean(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (['true', 't', '1', 'yes', 'y'].includes(normalized)) return true;
  if (['false', 'f', '0', 'no', 'n'].includes(normalized)) return false;
  throw new Error(`Invalid active value: ${value}`);
}

async function main(): Promise<void> {
  const csvPath = process.argv[2];
  if (!csvPath) {
    throw new Error('Usage: npm run import:prompts --workspace=@ai-visibility/csi-legacy -- /path/to/prompts.csv');
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required. Load .env before running the importer.');

  const workspaceSlug = process.env.CSI_WORKSPACE_SLUG ?? 'csi-dev';
  const promptSetName = process.env.CSI_PROMPT_SET_NAME ?? 'CSI AI Visibility Benchmark';
  const promptSetVersion = process.env.CSI_PROMPT_SET_VERSION ?? 'v1';
  const expectedCount = Number(process.env.CSI_EXPECTED_PROMPT_COUNT ?? '100');

  const csvText = await fs.readFile(csvPath, 'utf8');
  const parsed = parseCsv(csvText);
  if (parsed.length < 2) throw new Error('CSV contains no prompt rows.');

  const headerRow = parsed[0];
  if (!headerRow) throw new Error('CSV header row is missing.');

  const headers = headerRow.map(normalizeHeader);
  const required = ['prompt_id', 'prompt', 'category', 'intent', 'weight', 'active'] as const;
  const index = new Map(headers.map((header, i) => [header, i]));

  for (const column of required) {
    if (!index.has(column)) throw new Error(`CSV is missing required column: ${column}`);
  }

  function valueFor(values: string[], column: (typeof required)[number]): string {
    const position = index.get(column);
    if (position === undefined) throw new Error(`CSV is missing required column: ${column}`);
    return values[position] ?? '';
  }

  const rows: CsvRow[] = parsed.slice(1).map((values) => ({
    prompt_id: valueFor(values, 'prompt_id'),
    prompt: valueFor(values, 'prompt'),
    category: valueFor(values, 'category'),
    intent: valueFor(values, 'intent'),
    weight: valueFor(values, 'weight'),
    active: valueFor(values, 'active'),
  }));

  if (rows.length !== expectedCount) {
    throw new Error(`Expected ${expectedCount} prompt rows but found ${rows.length}. Import aborted.`);
  }

  const ids = new Set<string>();
  for (const row of rows) {
    const promptId = row.prompt_id.trim();
    if (!promptId || !row.prompt.trim() || !row.category.trim() || !row.intent.trim()) {
      throw new Error(`Prompt row ${promptId || '(blank id)'} has required blank fields.`);
    }
    if (ids.has(promptId)) throw new Error(`Duplicate prompt_id in CSV: ${promptId}`);
    ids.add(promptId);

    const weight = Number(row.weight);
    if (!Number.isFinite(weight)) throw new Error(`Invalid weight for prompt ${promptId}: ${row.weight}`);
    parseBoolean(row.active);
  }

  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
    max: Number(process.env.DATABASE_POOL_MAX ?? '10'),
  });

  const client = await pool.connect();
  try {
    const promptSetResult = await client.query<{ id: string }>(
      `SELECT psv.id
       FROM prompt_set_versions psv
       JOIN workspaces w ON w.id = psv.workspace_id
       WHERE w.slug = $1 AND psv.name = $2 AND psv.version = $3`,
      [workspaceSlug, promptSetName, promptSetVersion],
    );

    if (promptSetResult.rowCount !== 1) {
      throw new Error(`Expected exactly one prompt set for ${workspaceSlug} / ${promptSetName} / ${promptSetVersion}; found ${promptSetResult.rowCount ?? 0}.`);
    }

    const promptSetRow = promptSetResult.rows[0];
    if (!promptSetRow) throw new Error('Prompt set query returned no row after validation.');
    const promptSetId = promptSetRow.id;

    await client.query('BEGIN');

    for (const row of rows) {
      await client.query(
        `INSERT INTO prompts (
           prompt_set_version_id,
           external_prompt_id,
           prompt_text,
           category,
           intent,
           weight,
           active
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (prompt_set_version_id, external_prompt_id)
         DO UPDATE SET
           prompt_text = EXCLUDED.prompt_text,
           category = EXCLUDED.category,
           intent = EXCLUDED.intent,
           weight = EXCLUDED.weight,
           active = EXCLUDED.active`,
        [
          promptSetId,
          row.prompt_id.trim(),
          row.prompt.trim(),
          row.category.trim(),
          row.intent.trim(),
          Number(row.weight),
          parseBoolean(row.active),
        ],
      );
    }

    const countResult = await client.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM prompts WHERE prompt_set_version_id = $1',
      [promptSetId],
    );
    const countRow = countResult.rows[0];
    if (!countRow) throw new Error('Prompt count query returned no row.');
    const finalCount = Number(countRow.count);

    if (finalCount !== expectedCount) {
      throw new Error(`Post-import validation expected ${expectedCount} prompts but found ${finalCount}. Transaction rolled back.`);
    }

    await client.query('COMMIT');
    console.log(`Imported ${finalCount} prompts into ${workspaceSlug} / ${promptSetName} / ${promptSetVersion}.`);
    console.log('Production CSI Google Sheets and n8n were not modified.');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
