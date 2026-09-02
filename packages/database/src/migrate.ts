import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPostgresRepositoryFromEnv } from './postgres.js';

async function main() {
  const repository = createPostgresRepositoryFromEnv();
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const migrationPath = join(here, '..', 'migrations', '001_initial_schema.sql');
    const sql = await readFile(migrationPath, 'utf8');
    await repository.pool.query(sql);
    console.log('Applied migration 001_initial_schema.sql');
  } finally {
    await repository.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
