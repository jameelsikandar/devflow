# DevFlow 2.0

A developer collaboration workspace with project planning, task management, an
approval-based AI project manager, and secure GitHub activity and workflow automation.
Built with Next.js, React, TypeScript, Prisma and PostgreSQL.

**Current implementation: foundation through M3.4.** Implementation status and
verification status are tracked separately: database, browser and live-provider
acceptance must be confirmed in your environment. See [VERIFICATION.md](VERIFICATION.md)
for the latest actual results, and [CHANGELOG.md](CHANGELOG.md) for milestone history.

## Features

- Workspace authentication and roles; projects, labels, assignments, comments,
  presence and activity history; responsive dark/light themes.
- Five-column Kanban with keyboard/pointer drag-and-drop, Tasks lists, filters,
  dashboard and database-backed analytics.
- **M1:** interactive Gantt and timeline, milestones, drag scheduling, task
  dependencies with cycle prevention, deadline warnings and planned critical path.
- **M2:** persistent AI conversations, eight authorized project/task/sprint/report
  tools, safe Markdown, compact tool activity, proposal previews and explicit approval,
  idempotent receipts, task-version checks and Quick Drafts.
- **M3.1–M3.2:** GitHub OAuth, project repository connections, HMAC-verified webhooks,
  durable PostgreSQL processing, normalized GitHub objects, observation provenance,
  task references and task-dialog GitHub activity.
- **M3.3:** versioned administrator-managed PR workflow definitions, priorities,
  audit history, repository scope and strictly read-only previews.
- **M3.4:** confirmed future-event status automation, durable execution history,
  transactional status/activity writes, bounded retries, stale-version protection,
  event idempotency and safeguards against historical-event execution.

AI proposals cannot approve themselves. GitHub automation is a separate, explicitly
confirmed administrator grant for supported PR rules; rules are disabled by default.
Enabling a rule does not enqueue historical observations. Do not enable live rules
or start a worker against a live database merely to run verification.

## Stack and layout

| Layer                  | Technology                                                               |
| ---------------------- | ------------------------------------------------------------------------ |
| Application            | Next.js 16 App Router, React 19, TypeScript 5                            |
| UI                     | Tailwind CSS 4, shared CSS tokens, Radix Dialog, Lucide, Recharts        |
| State and interactions | TanStack Query, Zustand, React Hook Form/Zod, dnd-kit                    |
| Persistence            | PostgreSQL, Prisma 6 and committed SQL migrations                        |
| Integrations           | GitHub OAuth/REST/webhooks; OpenAI-compatible Chat Completions providers |
| Background work        | Separate Node.js worker using PostgreSQL; no Redis service               |
| Verification           | Vitest, real PostgreSQL integration suites, Playwright Chromium/mobile   |

```text
src/app/             Next.js pages and authenticated API routes
src/components/      Existing workspace UI, AI chat, roadmap and GitHub settings
src/lib/server/      Authorization, domain services, providers and GitHub worker logic
prisma/              Schema, seven additive migrations and optional local seed
scripts/             Worker, isolated test-database preparation and maintenance
tests/              Unit, DOM, SQL and database integration tests
e2e/                Desktop/mobile Playwright journeys
deploy/             Example GitHub worker systemd unit
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for architecture and authorization conventions.
Some early architecture notes predate GitHub automation; the latest
[GITHUB_INTEGRATION.md](GITHUB_INTEGRATION.md) sections describe M3.1–M3.4.

## Local installation

Requires **Node.js >=22.12**, **pnpm 11.9**, and PostgreSQL. The optional Compose
configuration uses PostgreSQL 18 and binds its port only to localhost.

```bash
pnpm install --frozen-lockfile
cp .env.example .env
# Edit .env locally; never commit it.
```

Set DATABASE_URL and APP_URL before starting the app. Optional integrations can
remain unconfigured: the AI displays a configuration state rather than fake answers.
The dependency build-script allowlist is recorded in pnpm-workspace.yaml. If pnpm
reports blocked dependency builds, review that allowlist rather than enabling every
package indiscriminately.

### Database setup

Choose an existing PostgreSQL service or the optional local Compose service. For
Compose, first set POSTGRES_PASSWORD in .env to match DATABASE_URL:

```bash
# Optional, starts a local database; skip when using an existing PostgreSQL service.
docker compose up -d --wait
pnpm db:generate
# Applies committed migrations to DATABASE_URL. Verify that target first.
pnpm db:migrate
pnpm dev
```

Open http://localhost:3000 and register an account. APP_URL must match the exact
browser origin, including hostname and port. A localhost/127.0.0.1 mismatch can
correctly fail origin checks.

Compose requires POSTGRES_PASSWORD explicitly; there is no committed password
fallback. Set it to the password configured in DATABASE_URL. Existing Docker volumes retain their database credentials; changing an
environment variable does not rotate an existing database password. Never reset or
remove a populated volume as a configuration shortcut.

The optional sample seed is for a fresh, disposable local evaluation database only:
configure a unique SEED_PASSWORD and deliberately run `pnpm db:seed`. It is not part
of normal installation, upgrades or verification against existing data.

For existing installations, back up the database outside this repository and apply
migrations deliberately. Do not use Prisma reset, destructive schema push, reseed,
or application data changes to resolve test failures. All seven migration files
remain source-controlled; generated clients and database files do not.

## Environment configuration

Copy the reviewed [.env.example](.env.example); keep actual values server-side in
ignored local environment files or your deployment secret store. Never expose them
through NEXT_PUBLIC variables, source control, screenshots or logs.

| Variable                                | Purpose                                                                       |
| --------------------------------------- | ----------------------------------------------------------------------------- |
| DATABASE_URL                            | Application PostgreSQL connection string; contains credentials                |
| TEST_DATABASE_URL                       | Separate integration/E2E database; use devflow_test                           |
| APP_URL                                 | Exact application origin; public HTTPS origin for real OAuth/webhooks         |
| TOKEN_ENCRYPTION_KEY                    | 32-byte key encoded as 64 hex characters; encrypts GitHub credentials/secrets |
| GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET | Optional GitHub OAuth application configuration                               |
| AI_API_KEY                              | Optional server-side OpenAI-compatible provider credential                    |
| AI_BASE_URL / AI_MODEL                  | Provider endpoint/model; model must support structured tool calls             |
| AI_DIAGNOSTICS                          | Optional sanitized aggregate provider diagnostics; off by default             |
| GITHUB_DEMO                             | Optional clearly labeled local demo; off by default                           |
| SEED_PASSWORD                           | Optional local evaluation seed; never use a shared production password        |
| POSTGRES_PASSWORD                       | Required for Compose; align DATABASE_URL                                      |
| GITHUB_WORKER_CONCURRENCY               | Concurrent work items, default 2                                              |
| GITHUB_WORKER_LEASE_SECONDS             | Delivery lease duration, default 120 seconds                                  |
| GITHUB_WORKER_MAX_ATTEMPTS              | Retry bound, default 8                                                        |
| GITHUB_WORKER_POLL_MS                   | Idle poll interval, default 2000 ms                                           |
| GITHUB_WORKER_ONCE_LIMIT                | Bounded --once workload, default 25 items                                     |
| GITHUB_WORKER_CONNECTION_ID             | Optional one-connection restriction; omit when unused                         |

Generate an encryption key locally with `openssl rand -hex 32` and store it only
in the secret environment. Preserve it securely: rotation requires planning for
already-encrypted connector credentials. No usable provider token or production
password belongs in an example file.

The AI adapter supports OpenAI-compatible providers, including Groq when configured
with a compatible model. Provider quota/rate limits remain external constraints.
See [AI_PROJECT_MANAGER.md](AI_PROJECT_MANAGER.md) and [AI_CHAT_UX.md](AI_CHAT_UX.md).

## GitHub setup and background worker

Configure a GitHub OAuth app with callback `APP_URL/api/github/callback`, then use
the existing GitHub integration UI to connect an authorized repository to a project.
OAuth and webhook verification are separate: configure the repository webhook using
the generated per-connection secret, shown once. Tokens and webhook secrets stay
server-side and encrypted; never paste them into documentation or issue reports.

After applying migrations and generating the Prisma client, build the worker:

```bash
pnpm github:worker:build
# In a separate terminal, deliberately targeting the intended database:
pnpm github:worker
# Alternative: bounded due-work processing, not an automatic execution bypass:
pnpm github:worker --once
```

`--once` budgets both delivery publication and workflow execution stages. Due work
may require more than one invocation; future backoff work needs the continuous
worker or a later run. Do not run these against the application database during
verification. The example systemd unit is in `deploy/devflow-github-worker.service`;
review paths, service identity and protected environment configuration before use.

M3.4 uses the same PostgreSQL-backed worker. It first publishes observations and
captures evaluation/version snapshots under a fenced delivery transaction. A later
short transaction revalidates scope, rule activation, current administrator role,
source evidence and task version before atomically recording the status change and
machine-attributed activity. Disabled rules, old delivery markers, pre-activation
events, stale facts, ambiguous references and conflicts cannot execute.

The existing M3.3 dry-run stays read-only. Enabling or editing an enabled rule
requires explicit confirmation and a new version-bound activation. For full setup,
retry/recovery behavior and the manual new-PR acceptance procedure, read
[GITHUB_INTEGRATION.md](GITHUB_INTEGRATION.md). Do not replay old receipts to test
live automation.

## Tests and production build

Use a **separate devflow_test database** in TEST_DATABASE_URL. Keep DATABASE_URL
pointing at the application database so the isolation guard can reject accidental
reuse. The preparation script creates the test database only if absent and applies
migrations there without resetting it.

```bash
pnpm db:prepare:test
pnpm db:generate
# Generate Next.js environment/types in a clean checkout before standalone tsc.
pnpm exec next typegen
pnpm typecheck
pnpm typecheck:core
pnpm lint
pnpm test
pnpm github:worker:build
pnpm build:webpack
AI_API_KEY= pnpm test:integration
# Install Chromium once in an environment with network/system permissions:
pnpm exec playwright install chromium
AI_API_KEY= pnpm test:e2e --reporter=list,html
```

Playwright starts its own test-database server on 127.0.0.1:3100 and refuses server
reuse. Keep that port free. Its server clears AI_API_KEY; no live Groq request is
required. GitHub transport tests use mocks. Database fixtures may enable automation
only inside the isolated test database; never enable a live rule for verification.

For production, run `pnpm build:webpack` and then `pnpm start` after the build
succeeds. A build passing is not database, browser or live-provider acceptance.
Follow [VERIFICATION.md](VERIFICATION.md) for actual results and remaining gates.

## Milestones and development history

| Milestone                                     | Implementation status                              |
| --------------------------------------------- | -------------------------------------------------- |
| Foundation                                    | Implemented                                        |
| M1 — Roadmap and Gantt                        | Implemented                                        |
| M2 — AI project manager                       | Implemented                                        |
| M3.1 — GitHub connections and signed webhooks | Implemented                                        |
| M3.2 — Worker, observations and task linking  | Implemented                                        |
| M3.3 — Workflow definitions and previews      | Implemented                                        |
| M3.4 — Safe GitHub status automation          | Implemented; runtime acceptance tracked separately |
| M3.5 and later                                | Not part of this baseline                          |

The local repository was initialized on `main` after development through M3.4.
No complete earlier application snapshots were recovered. The approved initial
history organizes today's source into **eight logical import commits**: configuration
and contracts, core management, roadmap, AI, GitHub processing, automation, shared
application assembly, and documentation/verification. These are review boundaries,
not reconstructed historical milestone states. Commit dates and authorship use the
actual Git environment; no earlier dates or milestone commits are invented.

Commits 1–6 contain compilable modules; the full Next.js app is assembled at commit 7
and the complete regression suites arrive at commit 8. All seven migrations stay
with their matching final schema in commit 1. See [COMMIT_PLAN.md](COMMIT_PLAN.md)
for exact paths, dependency checks and validation limits, [CHANGELOG.md](CHANGELOG.md)
for delivered milestone context, and [REPOSITORY_SETUP.md](REPOSITORY_SETUP.md) for
the preparation audit and execution guidance. `git log` is authoritative for which
approved commits have actually been created.

## Documentation and limitations

- [Architecture](ARCHITECTURE.md)
- [Upgrade plan](UPGRADE_PLAN.md) and [implementation report](UPGRADE_REPORT.md)
- [Verification results and local commands](VERIFICATION.md)
- [GitHub connection, worker and automation guide](GITHUB_INTEGRATION.md)
- [AI architecture/security](AI_PROJECT_MANAGER.md) and [chat UX](AI_CHAT_UX.md)
- [Preserved original README](docs/README_LEGACY.md), a historical document whose
  old milestone/verification statements are superseded by the current guides

Production readiness requires deployment-specific security and operational review.
Current limitations include custom session authentication without MFA/password
recovery, broad classic GitHub OAuth scopes, full-workspace snapshots at large scale,
advisory presence and a polling/SSE change feed. CSP hardening, connector lifecycle
operations and long-term retention/alerting need further work. Inspect the latest
technical guides before a public deployment.
