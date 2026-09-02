# Database

The platform persistence layer uses PostgreSQL. Google Sheets remains an import/export integration surface, not the primary application database.

## Initial schema

Migration `migrations/001_initial_schema.sql` creates:

- workspaces
- target entities, aliases, and owned domains
- competitor entities, aliases, and domains
- versioned prompt sets and prompts
- versioned scoring and authority profiles
- benchmark definitions and benchmark platforms
- benchmark runs
- logical observations
- observation attempts
- observation sources and detected entities
- authority results and evidence
- metric snapshots
- diagnostics and diagnostic evidence
- recommended actions

The database enforces one logical observation per `benchmark_run_id + prompt_id + platform_key`. Retry history belongs in `observation_attempts`; it does not create duplicate logical observations.

## Repository contract

`src/repository.ts` defines `PlatformRepository`, the persistence boundary consumed by the benchmark engine and web application.

`src/postgres.ts` implements that interface with `pg` and PostgreSQL. Observation writes are transactional and replace child source/entity rows as one logical update. Authority writes are also transactional and versioned by classifier version.

## Configuration

No database credentials are committed. Runtime configuration uses environment variables:

```bash
DATABASE_URL=postgresql://user:password@host:5432/database
DATABASE_SSL=true
DATABASE_POOL_MAX=10
```

`DATABASE_SSL=false` is available for local PostgreSQL. Hosted PostgreSQL defaults to TLS with certificate verification disabled at this foundation stage; deployment-specific hardening should replace that setting before production use.

## Apply the migration

From the repository root:

```bash
npm install
npm run migrate --workspace=@ai-visibility/database
```

The migration is not connected to any CSI production system and does not access n8n or the CSI Google Sheet.

## Current status

Schema and repository code exist, but no production PostgreSQL instance has been provisioned or migrated yet. The next validation step is to run this package against an isolated development database and add integration tests for uniqueness, resume/upsert, authority versioning, and complete-run retrieval.
