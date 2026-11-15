# DevFlow

A dark-first developer workspace built with Next.js App Router, TypeScript, PostgreSQL, and Prisma. Projects, a sortable five-column Kanban board, task details, comments, analytics, team presence, GitHub, and an AI assistant share one responsive interface.

**Upgrade status:** the codebase audit, project roadmaps/dependencies (Milestone 1), and agentic AI project manager (Milestone 2) are implemented. Milestone 3 has not started. TypeScript, ESLint, unit tests, schema checks and a webpack production build pass. API integration and browser tests still require verification outside the socket-restricted sandbox. See [UPGRADE_PLAN.md](UPGRADE_PLAN.md) and [UPGRADE_REPORT.md](UPGRADE_REPORT.md) for the remaining phases, exact results and release gates.

## Start locally

Requires Node **22.12+**, pnpm **11.9**, and PostgreSQL. The inspected Fedora environment has Node 22.23.1, pnpm 11.9.0, Docker 29.9.2, and PostgreSQL 18.6. No daemon is assumed to be running.

```bash
pnpm install
cp .env.example .env
# Edit .env: set SEED_PASSWORD to a unique password of at least 12 characters.
docker compose up -d --wait
pnpm db:generate
pnpm db:migrate
pnpm db:seed
pnpm dev
```

Open **http://localhost:3000**. Sign in as **alex@devflow.local** with your `SEED_PASSWORD`, or create your own account. Registration creates a separate private workspace; the sample studio is available to the seeded accounts. Seed users share the explicitly supplied seed password and are intended only for local evaluation. Re-seeding adds missing sample records without overwriting existing passwords or deleting your own work.

The seed creates **4 users, 3 projects, 30 tasks, 5 labels, comments, and activity records**. Dashboard numbers derive from those actual database records. Presence reflects connected clients, not sample users.

This checkout includes `pnpm-lock.yaml`. Use a complete local dependency installation and regenerate Prisma after every schema upgrade. Validation here used installed tools directly because pnpm auto-install attempts an unwritable store database in the execution sandbox.

### Recover from startup or build errors

If Turbopack cannot resolve `next/package.json`, or the build reports `prisma: command not found`, replace the temporary dependency tree with a complete installation. Its `next` and `.bin` entries may point to another project, outside this project's configured Turbopack root. From the directory containing `package.json`, with registry access available:

```bash
# Preserve the old tree while installing this project's own dependencies.
mv node_modules "node_modules.backup-$(date +%Y%m%d-%H%M%S)"
pnpm install
pnpm db:generate
pnpm dev
```

Complete the `.env` and database setup above before using the application. Keep `turbopack.root` scoped to this project in `next.config.ts`.

For production, stop the development server, run `pnpm build`, and only after it succeeds run `pnpm start`. The npm equivalents are `npm run build` and `npm start`; `npm build` and `npm next build` are not valid commands. `npm start` requires an existing successful production build in `.next`.

### Fedora notes

- Use a supported Node version and install pnpm using your preferred user-level package manager/Corepack.
- `docker compose version` and `docker info` must succeed before starting the database. If your account cannot access Docker, use an authorized Docker account or an existing/rootless PostgreSQL installation; the application does not change system permissions.
- Named Docker volumes avoid bind-mount SELinux labeling problems. The database is exposed only on `127.0.0.1:5433`.
- To use an existing PostgreSQL service, create a database and user, then replace `DATABASE_URL`; skip Docker Compose.
- `APP_URL` must exactly match the browser origin (including hostname and port). Using `127.0.0.1` with `APP_URL=http://localhost:3000` will fail origin checks.
- PostgreSQL 18 uses the `/var/lib/postgresql` container volume layout declared in Compose.

## Commands

| Command                             | Purpose                                                      |
| ----------------------------------- | ------------------------------------------------------------ |
| `pnpm dev`                          | Next.js development server                                   |
| `pnpm build`                        | Generate Prisma client and build Next.js                     |
| `pnpm start`                        | Serve the production build                                   |
| `pnpm lint`                         | ESLint, including React and accessibility rules              |
| `pnpm typecheck`                    | Strict TypeScript check                                      |
| `pnpm format` / `pnpm format:check` | Prettier write/check                                         |
| `pnpm test`                         | Unit tests with Vitest                                       |
| `pnpm test:integration`             | Real PostgreSQL and route-handler tests                      |
| `pnpm test:e2e`                     | Playwright desktop and mobile journeys                       |
| `pnpm db:generate`                  | Generate Prisma client                                       |
| `pnpm db:migrate`                   | Apply committed SQL migrations                               |
| `pnpm db:seed`                      | Populate the sample studio                                   |
| `pnpm db:studio`                    | Inspect records locally                                      |
| `pnpm db:cleanup`                   | Delete expired sessions, invitations, and rate-limit buckets |

## Main workflows

- Create or switch workspaces from the sidebar workspace selector.
- Create projects, open their boards, and archive/restore projects from the project cards. Archived work is retained and excluded from active analytics. Task edits are blocked while a project is archived.
- Create tasks, assign workspace members, choose priorities and dates, and attach workspace labels. Open a card to edit details, add comments, inspect history, or delete it with confirmation.
- Drag cards between columns or within a column in **Manual order**. Moves are optimistic and roll back on server errors. Version conflicts ask you to load the latest state instead of silently overwriting another member’s work.
- Filter the board by project, text, priority, member, and label; sort by manual order, priority, or date. Keyboard drag handles use Space and arrow keys. The task dialog’s status selector provides an additional keyboard workflow.
- **Tasks** shows workspace tasks, including unassigned tasks, with the same project and search filters as the board. Active, Completed, and All tabs filter by status. Analytics shows active projects/tasks, completion rate, overdue work, priority distribution, seven-day trends, health, and team contributions. Day buckets use UTC.
- Administrators create email-bound invitation links under **Settings & members**. Links expire after seven days. Share them yourself; no email service or outbound messaging is configured. The recipient must sign in with the invited email.
- Update name, PNG/JPEG avatar (512 KB maximum), and password in settings. A password change revokes existing sessions and creates a fresh current session.
- `Cmd/Ctrl+K` opens workspace search and actions; `C` creates a task when focus is outside an input or dialog. Theme and workspace preferences persist locally.

## Project roadmaps (DevFlow 2.0, milestone 1)

Apply the new migration and regenerate Prisma before starting the upgraded app:

```bash
pnpm db:generate
pnpm db:migrate
```

Open **Roadmap** in the sidebar or command palette and select a project. Existing
tasks stay unscheduled until given both dates; their existing due dates are retained.
Select a row to set its start/due dates or mark it as a single-day milestone. New
and existing task dialogs also support start dates. Drag a scheduled bar by its
grip to shift both dates, or use the date editor with a keyboard. Conflicting task
versions return 409 and refresh the roadmap rather than overwriting another edit.

Switch between Gantt and chronological Timeline layouts, zoom by day/week/month,
and navigate date windows. Dependencies connect tasks in the same project and are
shown with arrows. Self-links, cross-project links and circular graphs are rejected;
project locks serialize graph edits. Dependency arrows with conflicting dates are
red/dashed. Scheduling never silently moves successor tasks. Archived roadmaps can
be inspected but not edited. Changes produce activity and refresh other clients
through the existing SSE mechanism.

Critical path is **planned calendar-day CPM**, including completed tasks, with
inclusive task durations and zero-day milestones. It ignores resource constraints,
holidays and gaps between scheduled dates. It is unavailable until every task has
both dates. All scheduling and warnings use UTC days; overdue means an unfinished
task's due day is before today, and approaching means today through three days away.

New scoped APIs:

| Endpoint                       | Methods               | Input                                                                                               |
| ------------------------------ | --------------------- | --------------------------------------------------------------------------------------------------- |
| `/api/roadmap`                 | GET                   | `workspaceId` and `projectId` query parameters                                                      |
| `/api/roadmap/dependencies`    | POST, DELETE          | `workspaceId` query; JSON `{projectId, predecessorId, successorId}`                                 |
| `/api/tasks`, `/api/tasks/:id` | existing POST / PATCH | Additional `startDate` (ISO datetime/null), `isMilestone` (boolean); PATCH still requires `version` |

The migration adds nullable/defaulted task columns, date checks, scheduling indexes
and dependency records with composite foreign keys and cascade cleanup. It does not
delete/reseed existing data. Cycle prevention lives in the serialized application
service; direct database graph writers must use that service as well.

Where sandbox port restrictions prevent Turbopack builds, `pnpm build:webpack`
provides a verified alternative. No external credentials are needed for roadmaps.

## GitHub setup

Create a GitHub OAuth app with callback:

```text
http://localhost:3000/api/github/callback
```

Set these server-only `.env` values and restart:

```dotenv
GITHUB_CLIENT_ID="your-client-id"
GITHUB_CLIENT_SECRET="your-client-secret"
TOKEN_ENCRYPTION_KEY="64 hexadecimal characters"
```

Generate the encryption key with `openssl rand -hex 32`. Keep it backed up; rotating it requires reconnecting existing GitHub accounts. Connect from the GitHub screen, choose a project, and link a repository. The app requests `repo read:user` so it can read repositories, commits, and pull requests, including private repositories authorized by the user. This classic OAuth scope is broad; use a narrowly scoped GitHub App before a larger production rollout. Disconnecting removes the local encrypted token; revoke OAuth authorization in GitHub to revoke the upstream grant.

Tokens stay server-side and are stored with AES-256-GCM encryption. OAuth uses a short-lived HTTP-only state cookie. No GitHub credentials were available for a live OAuth/API test.

Set `GITHUB_DEMO=true` only for a local, clearly labeled **sample repository** panel. Demo records cannot be linked and do not pretend to be your GitHub data. Default is off.

## AI setup

Set server-only environment variables, then restart:

```dotenv
AI_API_KEY="your-provider-key"
AI_BASE_URL="https://api.openai.com/v1"
AI_MODEL="your-provider-model-id"
```

The provider must support Chat Completions function tools for **Project manager**.
HTTPS is required except for localhost providers. Keys remain on the server. A
missing key produces a setup state and 503, never simulated AI output. Configuration
state does not guarantee live provider compatibility; test your configured model.

Open **AI assistant → Project manager** for private conversations and structured
workspace queries. It can draft task briefs, propose child tasks, recommend priorities
or assignments, inspect blockers/overdue work, plan sprints and prepare reports.
Every proposed task/sprint/report write needs its own **explicit approval** of an
immutable preview. Approval rechecks authorization, expiry, related records and
server-captured versions, then commits the write and an idempotent receipt together.
Chat messages cannot approve changes. Reports attach actual snapshot metrics;
workload counts are not measured capacity or velocity.

Apply the new `202611130002_agent_manager` migration before using these features.
Approved sprint baselines and reports appear in the assistant's artifact section;
subtasks remain ordinary tasks with visible parent context. **Quick drafts** retains
the original six read-only assistant actions and `/api/ai` endpoint. Read
[AI_PROJECT_MANAGER.md](AI_PROJECT_MANAGER.md) for the API, security model, limits
and setup, and [UPGRADE_REPORT.md](UPGRADE_REPORT.md) for verification results.

## Tests

Unit tests cover password hashing, random sessions, authenticated token encryption/tamper rejection, origin checks, bounded request bodies, validation, non-destructive partial updates, fractional ordering, UTC analytics, AI configuration failures, and provider injection/errors.

Integration tests exercise registration/login/logout, session storage, project creation, task CRUD and movement, stale writes, comments/activity, project archiving, foreign-key cascades, and cross-workspace access denial against actual PostgreSQL. They require an isolated database ending in `_test` and refuse the main database URL.

```bash
# Reads the existing .env, creates/reuses an isolated _test database and applies migrations.
# Requires psql/createdb and a PostgreSQL role with permission to create a database.
pnpm db:prepare:test
pnpm test:integration
pnpm exec playwright install chromium
pnpm test:e2e --reporter=list,html
```

Playwright requires the isolated `TEST_DATABASE_URL`, starts its own server on
127.0.0.1:3100 with matching APP_URL, and never reuses the development server. Both
suites reject the application database, even if credentials, host aliases or schema
options differ. Browser tests create unique evaluation users/workspaces in the test
database. Chromium Linux libraries may require `pnpm exec playwright install-deps
chromium` with appropriate system access. See [VERIFICATION.md](VERIFICATION.md)
for safe development migration commands and current blockers.

`tests/schema.smoke.sql` separately verifies membership uniqueness, foreign keys, defaults, task positions/version checks, cascading children, and retained activity history, rolling back its fixtures:

```bash
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f tests/schema.smoke.sql
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f tests/roadmap.schema.sql
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f tests/agent.schema.sql
```

### Results from this sandbox — roadmap upgrade

| Check                               | Observed result                                                                                                       |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Prisma schema/client generation     | Passed using installed Prisma 6.19                                                                                    |
| Full TypeScript / ESLint            | Passed after baseline configuration/type repairs                                                                      |
| Vitest                              | **75 tests passed across 10 files**, including agent protocol, approval, run-state, task-service and roadmap tests    |
| SQL migrations and constraint tests | All three migrations and SQL suites passed against isolated PostgreSQL 18.6 standalone clusters; fixtures rolled back |
| Production build                    | **Passed with webpack**; default Turbopack is blocked by sandbox local-port restrictions                              |
| API integration tests               | Milestone 1 connection failed (13 skipped); eight new agent cases remain unrun; no blocked retries in Milestone 2     |
| Desktop/mobile E2E                  | Four cases discovered; execution remains blocked by EPERM and was not retried in Milestone 2                          |
| Visual browser QA                   | Unverified; browser access host unavailable                                                                           |
| GitHub / AI live calls              | Unverified; credentials unavailable. Existing provider failure paths are unit-tested                                  |

See [UPGRADE_REPORT.md](UPGRADE_REPORT.md) for test coverage, metric definitions,
new endpoints, migration requirements and the remaining mission phases.

## Architecture and operations

See [ARCHITECTURE.md](ARCHITECTURE.md) for data relationships, authorization, transport behavior, and design decisions. See [PLAN.md](PLAN.md) for implementation phases and verification status.

For production, use a managed PostgreSQL instance with TLS, backups, and a restricted application role. Set `APP_URL` to your HTTPS origin, install dependencies, commit the generated lockfile, apply migrations, and run all checks before deploying a persistent Next.js Node server. Cookies are Secure in production, so production login requires HTTPS. Run `pnpm db:cleanup` periodically. SSE needs an unbuffered streaming proxy and sufficiently long connection timeouts; short-lived serverless functions are not a verified target.

## Known limitations and incomplete work

- **Production readiness is not established.** TypeScript, lint, unit/schema checks and a webpack build pass; Prisma API integration, end-to-end journeys, and visual/accessibility browser QA remain unverified.
- Authentication currently uses a small custom PostgreSQL session implementation with maintained Node.js `crypto` primitives. An Auth.js/Better Auth integration was **not** completed. A maintained authentication framework and an independent security review remain appropriate before public production use.
- No password recovery, email verification, MFA, member removal/role administration, or account deletion workflow. These were not silently simulated.
- Invitations are shareable links rather than delivered emails. Labels can be added and attached, but renaming/deleting labels has no UI.
- SSE polls durable activity every two seconds, rotates connections every four minutes, and reconnects through EventSource. It is near-real-time, not a WebSocket broker. Full multi-user reconnect/revocation behavior is implemented but not integration-tested here.
- Workspace snapshots load all tasks. Large deployments need pagination, server-side search, bounded retention, and a more efficient change feed. Presence is advisory (45-second window).
- Fractional ordering uses floating-point positions; extreme repeated insertion into the same gap will eventually need transactional position rebalance. Concurrent writes to the same task are rejected; concurrent inserts into the same gap may tie and are displayed deterministically by ID.
- GitHub lists the first 100 repositories and the latest 8 commits/PRs. Pagination, webhooks, GitHub App permissions, and fine-grained repository privacy between workspace members are not implemented. Linked activity is fetched with each viewing user’s own GitHub authorization.
- CSP currently includes `unsafe-inline`/`unsafe-eval` for Next.js development compatibility. A nonce-based production CSP remains work for deployment hardening.
- Optional avatar images are byte-signature checked and stored privately in PostgreSQL; resizing/re-encoding, EXIF stripping, and external object storage are not implemented.
- A generated dependency lockfile and a complete package compatibility audit require registry access. The Node/Next/React baseline matches the installed Next.js project. The [official Next.js installation requirements](https://nextjs.org/docs/app/getting-started/installation) and [Prisma system requirements](https://docs.prisma.io/docs/orm/reference/system-requirements) were consulted; the exact full pinned dependency set could not be installed here.
