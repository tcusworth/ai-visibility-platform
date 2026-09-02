# Database

The platform persistence layer uses PostgreSQL. Google Sheets remains an import/export integration surface, not the primary application database.

## Initial schema

Migration `migrations/001_initial_schema.sql` creates workspaces, target entities, competitors, versioned prompt sets, scoring/authority profiles, benchmark definitions, benchmark runs, logical observations, observation attempts, sources/entities, authority results/evidence, metric snapshots, diagnostics, and recommended actions.

The database enforces one logical observation per `benchmark_run_id + prompt_id + platform_key`. Retry history belongs in `observation_attempts`; it does not create duplicate logical observations.

## Repository contract

`src/repository.ts` defines `PlatformRepository`, the persistence boundary consumed by the benchmark engine and web application.

`src/postgres.ts` implements that interface with `pg` and PostgreSQL. Observation writes are transactional. Authority writes are transactional and versioned by classifier version.

## Isolated development PostgreSQL

Local development uses the repository-level `docker-compose.dev.yml` file.

The development instance is intentionally isolated from other PostgreSQL installations:

- container: `ai-visibility-postgres-dev`
- database: `ai_visibility_dev`
- user: `ai_visibility`
- host port: `55432`
- container port: `5432`
- persistent volume: `ai_visibility_postgres_dev_data`
- SSL: disabled locally

The committed password is development-only and must never be reused for staging or production.

### First-time startup

From the repository root:

```bash
cp .env.example .env
npm install
npm run db:up
```

Then load the development environment and validate the database:

```bash
set -a
source .env
set +a
npm run db:healthcheck
npm run db:migrate
```

The healthcheck should report database `ai_visibility_dev` and user `ai_visibility`.

### Daily commands

```bash
npm run db:up
npm run db:down
npm run db:logs
```

### Destructive reset

```bash
npm run db:reset
```

`db:reset` deletes only the dedicated development Docker volume and recreates a clean local PostgreSQL instance. After reset, run `npm run db:migrate` again.

## Environment

`.env.example` contains the local template. `.env` is ignored by Git.

```text
DATABASE_URL=postgresql://ai_visibility:ai_visibility_dev_only@127.0.0.1:55432/ai_visibility_dev
DATABASE_SSL=false
DATABASE_POOL_MAX=10
```

Staging and production must use separate databases, separate credentials, and non-committed secrets.

## Isolation guarantee

This development database is unrelated to the CSI production environment. Starting, resetting, migrating, or deleting it does not touch CSI n8n workflows, the CSI Google Sheet, Apps Script, Netlify, or any other database.
