import { createPostgresRepositoryFromEnv } from './postgres.js';

async function main() {
  const repository = createPostgresRepositoryFromEnv();
  try {
    const result = await repository.pool.query<{
      database: string;
      user_name: string;
      server_version: string;
    }>(
      `select
         current_database() as database,
         current_user as user_name,
         current_setting('server_version') as server_version`,
    );

    const row = result.rows[0];
    if (!row) throw new Error('Database healthcheck returned no row.');

    console.log(`PostgreSQL reachable: ${row.database}`);
    console.log(`User: ${row.user_name}`);
    console.log(`Server version: ${row.server_version}`);
  } finally {
    await repository.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
