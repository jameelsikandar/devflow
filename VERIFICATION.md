# DevFlow local verification

## Current baseline — M3.5 step 1 (2026-11-15)

Branch: `feat/m3-5-operational-readiness`. Starting source: `48d7b5c`
(`test: add verification suites and implementation documentation`). The owner
created the branch locally; initial branch/index/worktree checks were clean.
This is baseline evidence before operational features, not M3.5 completion.
M1–M3.4 implementation is accepted from the owner; fresh runtime acceptance is
tracked separately. Earlier records below remain historical snapshots.

### Actual results from this run

Node: 22.23.1. Installed binaries were run directly, equivalent to the package's
pnpm scripts, to avoid the previously documented sandbox package-store restrictions.
No package installation or dependency update was needed.

| Check                        | Executed command                                                                    | Actual result                                                            |
| ---------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Prisma schema                | `node_modules/.bin/prisma validate`                                                 | Passed                                                                   |
| Prisma client                | `node_modules/.bin/prisma generate`                                                 | Passed; code generation only                                             |
| Unit/DOM                     | `node_modules/.bin/vitest run`                                                      | **326 passed, 37 files; 0 failed**                                       |
| ESLint                       | `node_modules/.bin/eslint .`                                                        | Passed                                                                   |
| Worker compilation           | `node_modules/.bin/tsc -p tsconfig.worker.json --pretty false`                      | Passed; worker not started                                               |
| Webpack production           | `node_modules/.bin/next build --webpack`                                            | Passed                                                                   |
| Full TypeScript              | `node_modules/.bin/tsc --noEmit --pretty false` after build/browser attempt         | Passed                                                                   |
| Core TypeScript              | `node_modules/.bin/tsc --noEmit -p tsconfig.core.json --pretty false`               | Passed                                                                   |
| Changed documentation format | Prettier check on the four files in this step                                       | Passed                                                                   |
| Repository-wide formatting   | `node_modules/.bin/prettier --check .`                                              | **Failed: four pre-existing source/test style violations**, listed below |
| PostgreSQL integration       | Guarded Vitest run with vitest.integration.config.ts and blank provider credentials | **6 connection-hook failures; all 82 tests skipped, 0 passed**           |
| Playwright desktop/mobile    | Existing suite with separate /tmp output/report directories                         | **0 tests executed**; EPERM probing 127.0.0.1:3100; webServer exited 1   |
| Browser discovery            | `node_modules/.bin/playwright test --list`                                          | **12 cases in 5 files**; discovery is not execution                      |

The full-repository formatter reported exactly these unchanged files:

- prisma/seed.ts
- src/lib/server/env.ts
- src/lib/server/errors.ts
- tests/core.test.ts

They match HEAD and were not modified by this step. This is an actual baseline
quality failure, separate from the PostgreSQL/browser infrastructure blockers.
No --write was run on them: preserve the documentation-only commit and address
formatting in a separate focused change after the owner confirms this commit.
A suitable follow-up message is `chore: normalize baseline source formatting`.
Relevant formatting/type/unit checks must run for that change; do not report the
repository-wide format gate green until its check actually passes.

The database wrapper loaded the existing local configuration, called
`requireTestDatabase`, and required exactly `/devflow_test` before invoking Vitest.
Its sanitized target was **localhost:5433/devflow_test**. All six beforeAll hooks
failed with Prisma initialization errors: cannot reach localhost:5433. No database
assertions ran. This does not establish the test database's migration status or
contradict the owner's earlier Fedora evidence that seven migrations were applied.
No migration, reset, database creation or seed command was run in this baseline.

The Playwright probe reported `connect EPERM 127.0.0.1:3100`; the configured server
could not start. No browser assertions, screenshots or visual QA ran. Browser
output was redirected to `/tmp/devflow-m35-baseline-browser-results` and the HTML
report to `/tmp/devflow-m35-baseline-playwright-report`, preserving existing local
project reports/traces. No socket, Docker, alternate database or permission workaround
was attempted after either infrastructure failure.

Unit/build/test commands cleared AI_API_KEY and GitHub client configuration where
applicable; database/browser fixtures need no live provider credentials. No live
GitHub/Groq request, webhook creation, standalone worker, connection revalidation,
automation-rule change or DEV-002 update was performed. Prisma generation and worker
compilation are not database migrations or worker execution. Source/application,
schema, migrations and test configuration remain unchanged; only milestone docs
are being prepared for the first focused local commit.

### Reproduce the baseline in a normal Fedora shell

Use the already-migrated isolated devflow_test database. Keep DATABASE_URL and
TEST_DATABASE_URL distinct in the ignored .env. Validate the target before tests;
the commands below do not reset, reseed or migrate either database.

```bash
node --import tsx -e 'require("dotenv/config"); const {requireTestDatabase}=require("./tests/database-config.ts"); const u=requireTestDatabase(process.env.DATABASE_URL,process.env.TEST_DATABASE_URL); if(u.pathname!=="/devflow_test")throw Error("Only devflow_test permitted"); console.log("Verified isolated test database",u.hostname,u.port,u.pathname);'
pnpm exec prisma validate
pnpm db:generate
pnpm lint
AI_API_KEY= GITHUB_CLIENT_ID= GITHUB_CLIENT_SECRET= pnpm test
pnpm github:worker:build
AI_API_KEY= GITHUB_CLIENT_ID= GITHUB_CLIENT_SECRET= pnpm build:webpack
pnpm typecheck
pnpm typecheck:core
AI_API_KEY= GITHUB_CLIENT_ID= GITHUB_CLIENT_SECRET= pnpm test:integration
# Keep 3100 free; this starts only the existing isolated test server, not the worker.
AI_API_KEY= GITHUB_CLIENT_ID= GITHUB_CLIENT_SECRET= PLAYWRIGHT_HTML_OPEN=never pnpm test:e2e --reporter=list,html
pnpm exec prettier --check UPGRADE_PLAN.md UPGRADE_REPORT.md VERIFICATION.md GITHUB_INTEGRATION.md
# This baseline command currently fails on the four listed unchanged files:
pnpm format:check
```

For reproducibility, the sandbox browser invocation was:

```bash
AI_API_KEY= GITHUB_CLIENT_ID= GITHUB_CLIENT_SECRET= DEBUG=pw:webserver PLAYWRIGHT_HTML_OPEN=never PLAYWRIGHT_HTML_OUTPUT_DIR=/tmp/devflow-m35-baseline-playwright-report node_modules/.bin/playwright test --output=/tmp/devflow-m35-baseline-browser-results --reporter=list,html
```

The PostgreSQL invocation used this fail-closed wrapper (no URL secrets printed):

```bash
node --import tsx -e 'require("dotenv/config"); const {requireTestDatabase}=require("./tests/database-config.ts"); const u=requireTestDatabase(process.env.DATABASE_URL,process.env.TEST_DATABASE_URL); if(u.pathname!=="/devflow_test")throw Error("Only devflow_test permitted"); console.log("Verified isolated target",u.hostname,u.port,u.pathname); const r=require("node:child_process").spawnSync(process.execPath,["node_modules/vitest/vitest.mjs","run","--config","vitest.integration.config.ts"],{env:{...process.env,AI_API_KEY:"",GITHUB_CLIENT_ID:"",GITHUB_CLIENT_SECRET:""},stdio:"inherit"}); process.exitCode=r.status??1;'
```

### Current release and commit gates

- TypeScript/lint/unit/build and changed-document formatting checks pass; the full
  repository format check fails on four unchanged files. The database and browser commands
  exited unsuccessfully at infrastructure setup; their assertions are unverified,
  not application passes or confirmed assertion regressions.
- Actual passing PostgreSQL/concurrency and desktop/mobile evidence is still required
  for M3.5 acceptance. Do not substitute historical counts, discovery or mocks.
- Health, scoped diagnostics, read-only retention reporting, CI and deployment
  evidence are steps 2–9 and remain unimplemented in this first change.
- Live lifecycle acceptance needs separate explicit approval or owner-run disposable
  test scope. Existing credentials, rules, DEV-002 and production records are not
  test fixtures. No real hook creation, merge, grant revocation or live automation
  is authorized by running baseline checks.
- Prepared commit: `docs: reconcile milestone status and operational acceptance gates`.
  Only UPGRADE_PLAN.md, UPGRADE_REPORT.md, VERIFICATION.md and GITHUB_INTEGRATION.md
  belong to this step. No staging/commit attempt occurs in the read-only sandbox.
  **Wait for the owner's commit confirmation before starting step 2.**

## Historical environment result — initial roadmap verification

This execution sandbox cannot connect to PostgreSQL or listen for HTTP. Both TCP
and Unix socket attempts return `EPERM`; Docker access is denied. A visible socket
at `/tmp/.s.PGSQL.5432` does not establish which database is running or make it
accessible. The application is configured for `localhost:5433/devflow`.

`prisma migrate status` returns P1001. The live migration state is unknown; no
development database reset, deletion, reseed or migration was performed here.

The previous Milestone 1 attempt below remains blocked. Milestone 2 did not retry
these prohibited operations. That earlier run passed Prisma generation, TypeScript (full/core),
ESLint, 75 unit tests and a webpack production build; current counts are recorded
in the latest follow-up below. The API suite was attempted with a distinct
`devflow_test` target: its connection hook fails and all 13 tests are skipped.
Playwright was attempted for both configured desktop/mobile projects, but its
isolated server cannot listen on port 3100. No browser assertions or screenshots
were executed. The separate browser-access host is unavailable as well.

## Run from the normal Fedora terminal

From the repository directory, with the existing development `.env`:

```bash
# If using the project's Compose database and it is not already available:
docker compose up -d --wait postgres

# Inspect first. Pending migrations can make status exit nonzero.
pnpm exec prisma migrate status
# Applies pending committed migrations; does not reset existing data.
pnpm db:migrate
pnpm db:generate

# Requires local psql/createdb tools and a role allowed to create a database.
pnpm db:prepare:test

pnpm test:integration
pnpm exec playwright install chromium
pnpm test:e2e --reporter=list,html

pnpm typecheck
pnpm typecheck:core
pnpm lint
pnpm test
pnpm build:webpack
```

`db:prepare:test` reads the application connection without printing its password.
It uses `TEST_DATABASE_URL` if configured, otherwise appends `_test` to the
application database name. It rejects the application database even if credentials,
host aliases or schema options differ. It creates the test database **only if absent**,
retains an existing test database's data, and applies committed migrations there.
After successful database access/creation it saves a derived `TEST_DATABASE_URL`
to ignored `.env`. It never executes DROP, reset or db push.

If the application role cannot create databases, create the separate database using
an authorized local PostgreSQL role, then set `TEST_DATABASE_URL` in `.env` and rerun
`pnpm db:prepare:test`. The name must end in `_test`. Keep the existing
`DATABASE_URL` pointing to the development database. If you use a PostgreSQL service
other than Compose, use its existing connection settings instead of starting Compose.

The browser suite requires `TEST_DATABASE_URL` and starts its own Next.js webpack
development server at **http://127.0.0.1:3100**, using that database and matching
`APP_URL`. It **does not reuse** an existing application server. Keep port 3100 free.
An optional `E2E_BASE_URL` may choose another local HTTP origin. Tests register unique
users/workspaces inside the test database; integration cleanup removes only its own
fixtures. Browser fixtures remain available for inspection in the test database.

The suite captures dark/light screenshots per project in ignored `test-results/`
after successful roadmap operations. Inspect them and the HTML report; screenshot
creation alone is not a visual review. Traces are retained on failure.

```bash
pnpm exec playwright show-report
```

## Coverage and acceptance criteria

- Registration/login/logout, unassigned Tasks visibility, project creation, Kanban
  task visibility/status persistence, comments and command-palette search.
- Roadmap scheduling, milestones, dependency addition/removal/re-addition, cycle
  rejection, day zoom and chronological Timeline layout.
- Desktop pointer drag and mobile-profile keyboard drag shift a three-day interval;
  both dates and milestone markers persist after reload. Conflicting dependency
  dates display a warning, resolved by a corrected milestone schedule.
- Analytics charts render; dark/light screenshots are saved; uncaught browser
  errors fail the journey.
- Database integration covers cross-workspace access and archive boundaries,
  concurrent opposite/transitive edges, idempotent link operations, invalid schedules,
  stale/conflicting versions and cascade cleanup.

Review Gantt/Timeline and all day/week/month scales, pointer/touch and keyboard
interaction, narrow-screen scrolling, connector alignment, reduced motion and both
themes in the running app before closing the visual gate. No live feature regression
is ruled out until the database and browser tests actually pass.

Milestone 2 was subsequently authorized and implemented without retrying prohibited
operations. Its available checks pass; Milestone 1/2 API/concurrency/browser gates
remain open, and Milestone 3 has not started. Do not substitute passing unit tests,
standalone schema tests or a build for those blocked verification gates.

## Milestone 2 local checks

The commands above now apply all three migrations and run both integration suites.
The new eight-case agent integration suite uses an explicitly stubbed provider with
real database/authentication/approval services. It verifies private/scoped access,
no domain writes before approval, concurrent approval replay, stale versions,
sprint baselines/overlap, reports, expiry and run fencing. No API key is required for
these integration fixtures. The four browser cases include desktop/mobile roadmap
and AI-review journeys. AI browser responses are explicitly intercepted fixtures;
they test review/approval UI behavior, not real LLM execution or persistence.

The three SQL suites can also run on the isolated database (fixtures roll back):

```bash
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f tests/schema.smoke.sql
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f tests/roadmap.schema.sql
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f tests/agent.schema.sql
```

If `db:prepare:test` saved the URL only in `.env`, load it into your shell before
using these psql commands, or pass the test connection using your normal PostgreSQL
client configuration. The test runner and preparation command load `.env` themselves.

For a live-provider acceptance check, configure the server environment described in
`AI_PROJECT_MANAGER.md`, restart normally, and open AI assistant → Project manager:

1. Ask for actual project/task progress and compare identifiers/counts with the UI.
2. Request a brief, child tasks or priority change. Verify tasks remain unchanged
   while previews are pending; inspect every displayed field before approving one.
3. Reject another preview; reload and confirm the decision/history persists.
4. Change a task through Tasks after its AI preview. Confirm the old approval is
   rejected rather than overwriting the new version.
5. Propose/approve a sprint and weekly report, checking task baselines and source
   timestamps/count definitions. Inspect saved artifacts after reload.
6. Review both themes, mobile scrolling, error/configuration states and keyboard
   access. Test another member's account to verify private history is inaccessible.

Provider output quality/compatibility, live database concurrency and visual approval
review remain unverified until these local checks actually run.

## AI chat rendering follow-up (2026-11-13)

Current available checks: **99 tests in 12 files pass**, including jsdom-mounted
message/history/approval/Quick Drafts and security interactions; TypeScript full/core,
ESLint, Prisma client generation and webpack build pass. Changed-source Prettier passes.
Whole-repository Prettier still reports pre-existing differences in seed, globals,
Kanban, env/errors, core tests and generated next-env; these were left untouched.
Use `node_modules/.bin/{vitest,tsc,eslint,prettier,next,prisma}` here to avoid pnpm's
unwritable automatic-install SQLite store. Normal local `pnpm` commands above remain
appropriate after `pnpm install --frozen-lockfile`.

No PostgreSQL, Docker, HTTP-listen or browser attempt was repeated. Integration now
contains 22 tests, including persisted personal/all/unassigned read scopes; none was
executed in this follow-up. The same four browser cases are configured, now with AI
Markdown tables/code, safe links, collapsed tool details, theme screenshots and
mobile overflow assertions. They were not executed here. Run `pnpm test:integration`
and `pnpm test:e2e --reporter=list,html` after the isolated test setup above.

See `AI_CHAT_UX.md` for exact rendering decisions, code-highlighting language limits,
new dependencies and a live Groq/manual UX checklist. Semantic DOM tests and passing
builds do not establish actual desktop/mobile layout, contrast, clipboard permissions
or configured-model answer quality. These remain explicit local acceptance gates.

## Latest task/context and full Assistant follow-up — 2026-11-13

- Executed: **118 tests pass in 12 files**, full/core TypeScript, ESLint, Prisma
  client generation, webpack production build and changed-source Prettier.
- Whole-repo Prettier: seven existing/generated differences remain (next-env.d.ts,
  seed, globals, Kanban, env/errors, core tests). Unrelated source was left unchanged.
- Discovered only: **23 real-database integration tests and six desktop/mobile
  browser cases**. Neither suite was executed in this follow-up.
- Browser inventory checked: apps/browsers empty; `The browser access host is
unavailable`. No screenshots, rendered UI measurements or contrast inspection.
- Previously confirmed PostgreSQL socket/TCP EPERM, Docker denial and HTTP listening
  EPERM were not retried. Development database data/migration state was untouched.
- No live Groq request was made; mocked provider/HTTP fixtures are labeled as such.

`pnpm` invokes an automatic install against an unwritable store in this sandbox.
Equivalent checks used `node_modules/.bin/tsc --noEmit`, `tsc --noEmit -p
 tsconfig.core.json`, `eslint .`, `vitest run`, `prisma generate`, `next build
 --webpack` and changed-file `prettier --check`. TypeScript was run after the build
so generated .next types were not being replaced during the standalone check.

Run outside this sandbox from the repository, preserving the existing Groq `.env`:

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm typecheck:core
pnpm lint
pnpm test
pnpm build:webpack
# Creates/applies existing migrations only on a distinct *_test database; no reset:
pnpm db:prepare:test
pnpm test:integration
pnpm exec playwright install chromium
pnpm test:e2e --reporter=list,html
```

Keep port 3100 free; Playwright starts its own isolated Next server using the test
DB. Do not point tests at the app DB. Existing setup/isolation details above still
apply. No new migration is needed for this task/context follow-up.

The added browser journey checks selected-project inheritance, three actual isolated
unassigned task fixtures (with real generated references), zero personal matches and
separate project context, task detail navigation, new scope creation/history,
composer visibility/overflow and light/dark screenshots. Its AI conversation responses
are intercepted fixtures. The added integration case uses real authorized database
reads for context, completed/unfinished filtering, pages/counts and archive/member
boundaries with an injected provider for context persistence.

See `AI_CHAT_UX.md` for the full live Groq and desktop/tablet/mobile acceptance list.
In particular, compare "My current tasks?" against "Show my assigned tasks" and
"Show all project tasks" using current records. The historical three unassigned
tasks explain the reported behavior; they are not asserted to be today's live data.
Live Groq compliance, PostgreSQL execution and visual behavior remain unverified.

## Latest workspace/reliability repair — 2026-11-13

Executed: **144 tests pass in 13 files**, full/core TypeScript, ESLint, Prisma generate,
webpack production build, changed-file formatting. Whole-repository Prettier has the
same seven unrelated/generated differences listed in the report.

Discovery only: **24 real-PostgreSQL integration tests, six browser cases**. These
were not executed. Current browser inventory again reports no surfaces and
`The browser access host is unavailable`. No supplied screenshot file was available
in the repository. No screenshot or actual page inspection was performed. Known
PostgreSQL socket and HTTP-listen EPERM/Docker restrictions were not retried.
No development DB migration/reset or live provider request was made.

Use the normal-terminal commands above (`pnpm typecheck`, `typecheck:core`, `lint`,
`test`, `build:webpack`, `db:prepare:test`, `test:integration`, Playwright Chromium
installation and `test:e2e --reporter=list,html`). The safe isolated test DB suffix
and dedicated port-3100 server requirements are unchanged. No new migration/package
is required. Sandbox checks used installed `.bin` executables because pnpm's automatic
install store remains unavailable here.

Before accepting the UI, run `pnpm dev` and inspect 1440/1024/768/390px in both themes:
one conversation message scroll region, stable global shell, reachable compact input,
history title truncation/drawer focus, header disclosure, plans pane, table/code
scrolling and soft keyboard. Compare actual screenshots with the reported defects.
The browser fixture includes overflow/composer assertions and screenshot paths but
**no generated screenshot artifacts are claimed**. Update the old 118-test report
status only with actual newer execution results, not discovery.

Provider fixtures test 429 seconds/HTTP dates/Groq reset durations, absent timing,
process cooldown suppression, safe headers and partial tool persistence without task
or proposal writes. Automatic retries are zero. The browser fixture injects a late
429 after successful isolated task reads; it does not prove Groq's live behavior.
See the current `AI_CHAT_UX.md` for provider/cache limits and the full acceptance list.
Visual, PostgreSQL-concurrency and live Groq gates remain open.

## Latest context/routing efficiency follow-up — 2026-11-13

- Executed: **172 tests pass in 15 files**, full/core TypeScript, ESLint, webpack
  production build and changed-source formatting. Unrelated repo format differences
  from the prior report remain.
- Discovered only: **25 real-DB integration tests and six browser cases**. No assertions
  from these suites were executed. Existing PostgreSQL socket/HTTP-listen restrictions
  and unavailable browser host were not re-probed; no layout was changed.
- No live Groq request/token/quota values measured. Aggregate diagnostics are opt-in
  with `AI_DIAGNOSTICS=1` (server-only), as shown in `.env.example`.
- The new integration fixture uses real task records to verify workspace assigned/all,
  unique named project and selected-project follow-up without invoking its deliberately
  unavailable injected provider. Mocked unit tests do not replace this execution gate.

Run the existing normal-terminal commands above: `pnpm typecheck`, `typecheck:core`,
`lint`, `test`, `build:webpack`; prepare the separate `_test` database using
`pnpm db:prepare:test`, then `pnpm test:integration` and
`pnpm test:e2e --reporter=list,html`. No new migration is needed; never reset or point
these tests at the application DB. Installed `.bin` equivalents were used here
because pnpm auto-install targets its previously documented unwritable store.

Manual runtime acceptance: compare My assigned tasks, My current tasks, All project
tasks, All workspace tasks and Unassigned tasks in workspace/pinned conversations.
Check sole vs multiple projects, unique/duplicate explicit names and prior project
selection. Recognized reads should show a labeled database summary with zero provider
rounds, even during known Groq cooldown. Complex requests must retain provider/error/
partial-data behavior and explicit mutation approvals. A new turn/fresh=true should
see updates; reused reads must stop after membership removal or project archive.
Diagnostics may reveal the future live quota bucket but do not bypass it. See
AI_CHAT_UX.md for precise supported intent/default/freshness and logging semantics.

## Latest repair verification — 2026-11-13

This section supersedes earlier execution counts. The supplied Fedora run exposed
one real sprint persistence defect and several browser synchronization/selector
failures. All six saved traces and error-context files were inspected before edits.
Two original desktop screencast frames were viewed. Original failure directories
were copied to `/tmp/devflow-repair-original-results` before Playwright ran, then
restored beneath `test-results/`; they are **not new successful verification**.

Executed installed-binary equivalents of the requested pnpm scripts (pnpm's known
store/auto-install restriction was not retried):

| Check                                                                            | Actual result                                               |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `node_modules/.bin/prisma generate`                                              | Pass, client 6.19.0                                         |
| `node_modules/.bin/tsc --noEmit`                                                 | Pass, after production build                                |
| `node_modules/.bin/tsc --noEmit -p tsconfig.core.json`                           | Pass                                                        |
| `node_modules/.bin/eslint .`                                                     | Pass                                                        |
| `node_modules/.bin/vitest run`                                                   | **177 passed, 16 files**                                    |
| `AI_API_KEY= node_modules/.bin/next build --webpack`                             | Pass, includes route generation and Next TypeScript check   |
| Prettier check of all seven changed source/config/test files                     | Pass                                                        |
| `AI_API_KEY= node_modules/.bin/vitest run --config vitest.integration.config.ts` | **2 setup failures, 25 skipped**; no DB assertions executed |
| `AI_API_KEY= node_modules/.bin/playwright test --reporter=list,html`             | **0 cases executed**; webServer exited with code 1          |

The integration error was `PrismaClientInitializationError: Can't reach database
server at localhost:5433`, at each suite's initial `$connect()`. Neither suite
reached fixture creation or cleanup. The configured isolated DB is `devflow_test`,
distinct from the application DB; existing safety guards validate this before
execution. No migrations, DB resets or application-data changes were attempted.
The process inventory showed no PostgreSQL/Next server in this sandbox. Playwright
used `reuseExistingServer: false` and its isolated test DB environment; it did not
report a conflicting server. Its only emitted startup diagnostic was
`Process from config.webServer was not able to start. Exit code: 1`. No underlying
bind error was emitted, so an EPERM cause is not claimed for this attempt. Earlier
sandbox restrictions are documented above; repeated server/network probes were
not attempted. Browser launch, repaired journeys, and new desktop/mobile screenshots
remain unverified. No live Groq behavior was tested.

New unit execution tests initially had one incorrect expectation that dates would
be coerced to Date objects; the existing schema keeps ISO strings (valid Prisma
inputs). That test expectation was corrected and the full suite above passed.

Run locally, with the existing `.env` values for separate application and test URLs
and no other server on port 3100:

```bash
# Start your existing PostgreSQL service/container exposing port 5433 first.
# If the isolated DB needs preparation, this applies migrations without resetting:
pnpm db:prepare:test
pnpm db:generate
pnpm typecheck
pnpm typecheck:core
pnpm lint
pnpm test
pnpm build:webpack
AI_API_KEY= pnpm test:integration
AI_API_KEY= pnpm test:e2e --reporter=list,html
```

No new migration is required. Do not point `TEST_DATABASE_URL` at the application DB.
Playwright clears the server's AI key and uses intercepted AI fixtures; integration
agent calls use injected providers. If local server startup still fails, capture
`DEBUG=pw:webserver AI_API_KEY= pnpm test:e2e --reporter=list,html` output. Review
new traces/screenshots after execution, including mobile history restoration,
priority/status persistence, proposal approval/rejection, task navigation, Quick
Drafts and both themes. No browser case is marked passed here.

## Latest roadmap removal repair — 2026-11-13

User-reported Fedora results before this repair: **25/25 integration tests passed;
4/6 browser tests passed**, with all four AI journeys passing. Both remaining
workspace traces/snapshots show the actual removal control and a DELETE HTTP 400
response rejecting `createdAt`; the existing list-count assertion is accurate.

Production fix: whitelist the three dependency command identifiers in the client
request body. Keep strict server validation and the existing success refresh path.
The new rendered-component regression loads metadata-bearing server data, clicks
the accessible removal control, enforces the strict request schema in a mocked HTTP
handler and verifies the refetched empty list. Real database deletion, idempotency,
cycle and concurrency checks remain in the unchanged 25-test integration suite.

Executed installed-binary equivalents of the requested pnpm scripts:

- `node_modules/.bin/tsc --noEmit`: passed after the production build.
- `node_modules/.bin/tsc --noEmit -p tsconfig.core.json`: passed.
- `AI_API_KEY= node_modules/.bin/next build --webpack`: passed, including route generation.
- `AI_API_KEY= node_modules/.bin/vitest run`: **178 passed, 17 files**.
- `node_modules/.bin/eslint .`: passed.
- Prettier check of the changed component and regression test: passed.
- `AI_API_KEY= node_modules/.bin/vitest run --config vitest.integration.config.ts`:
  **2 suite setup failures, 25 skipped**. Initial Prisma `$connect()` could not reach
  `localhost:5433`; no database assertions or fixture writes executed.
- `DEBUG=pw:webserver AI_API_KEY= node_modules/.bin/playwright test --reporter=list,html`:
  **zero browser cases executed**. Availability checks report
  `connect EPERM 127.0.0.1:3100`, followed by webServer exit code 1.
  This attempt confirms the sandbox networking restriction, rather than another
  application test failure. No repeated server probes were attempted.

Configuration still names `devflow_test` as the isolated test database, distinct
from `devflow`; both test configurations enforce isolation. No database preparation,
reset, migration or application-data modification was performed. No PostgreSQL/Next
server appeared in the process inventory. Playwright refuses an existing server and
clears its AI key. Original failure trace directories were backed up under
`/tmp/devflow-roadmap-original-results` and restored to `test-results/`; these are
original failures, not fresh screenshots or successful runs.

After starting your existing PostgreSQL instance on port 5433, rerun locally with
the existing separate `DATABASE_URL` / `TEST_DATABASE_URL=.../devflow_test` settings
and port 3100 free:

```bash
pnpm typecheck
pnpm typecheck:core
pnpm lint
pnpm test
pnpm build:webpack
AI_API_KEY= pnpm test:integration
AI_API_KEY= pnpm test:e2e --reporter=list,html
```

No new migration or reset is required. Acceptance targets remain 25/25 database and
6/6 browser passes after this fix; neither is claimed from sandbox execution.

## M3.1 GitHub connection/webhook foundation — 2026-11-13

This section records M3.1 only; it does not close M3.2–M3.5 or live-provider gates.
The user reports the previous 25/25 PostgreSQL suite passing locally, all four AI
browser cases passing and manual roadmap acceptance. That is historical acceptance
for earlier code, not execution of the new GitHub integration cases.

### Executed checks

Commands use installed script-equivalent binaries; the known pnpm auto-install/store
restriction was not retried. No dependencies or lockfile changes were required.

| Command                                                                          | Actual result                                        |
| -------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `node_modules/.bin/prisma generate`                                              | Pass, Prisma 6.19.0 client including M3 models       |
| `node_modules/.bin/prisma validate`                                              | Pass                                                 |
| `node_modules/.bin/tsc --noEmit`                                                 | Pass (rerun after webpack)                           |
| `node_modules/.bin/tsc --noEmit -p tsconfig.core.json`                           | Pass                                                 |
| `node_modules/.bin/eslint .`                                                     | Pass                                                 |
| `AI_API_KEY= node_modules/.bin/vitest run`                                       | **206 passed, 20 files**                             |
| `AI_API_KEY= node_modules/.bin/next build --webpack`                             | Pass, includes `/api/github/webhooks/[connectionId]` |
| Prettier on changed TypeScript/TSX/JSON/Markdown files                           | Pass                                                 |
| `AI_API_KEY= node_modules/.bin/vitest run --config vitest.integration.config.ts` | **3 suite setup failures, 34 skipped tests**         |

The integration suites fail at their initial Prisma `$connect()`: database server
`localhost:5433` is unreachable. None of the nine new GitHub cases or original 25
DB cases executed assertions/fixture writes. No repeated network probes, migration
attempts against unreachable endpoints, database resets or application-data writes
were performed. The additive migration was generated with schema-to-schema diff,
which needs no database; it has not been applied here. Prisma generation/validation
are not SQL migration-execution verification. Integration configuration still
requires a separate `devflow_test` database and refuses the application database.

The new unit/DOM tests cover published HMAC vector/exact bytes, malformed signatures,
minimal data retention, capped commit records, repository permission/role failures,
workspace filters, receipt reuse with changed delivery ID, failed durable writes,
disconnect recheck and one-time setup dialog/explicit disconnect. They use mocked
HTTP/database boundaries where stated. Real-DB cases add concurrent duplicate
receipts/connections, composite FK and cross-workspace isolation, signature/input
rejection, persistence, soft disconnect/reconnect and archive/race behavior.

Initial development checks found and fixed a CopyButton prop mismatch, an incorrect
copied HMAC fixture value, and a repository-name validator that allowed a `..` owner
segment. The final executed unit/type/build results above reflect the fixes.

No live GitHub or Groq calls were made. Browser execution was not reattempted after
the documented localhost EPERM restriction; the setup-dialog fixture is DOM coverage,
not a visual or live-OAuth acceptance claim. No M3 screenshots were captured.

### Local verification and acceptance

With your existing PostgreSQL instance reachable, application and test database
URLs naming different databases, and the test database ending in `_test`:

```bash
# Uses only the isolated test DB; applies pending migrations without resetting it.
pnpm db:prepare:test
pnpm db:generate
pnpm typecheck
pnpm typecheck:core
pnpm lint
pnpm test
pnpm build:webpack
AI_API_KEY= pnpm test:integration
# Existing browser regressions: let Playwright own port 3100 and its test DB server.
AI_API_KEY= pnpm test:e2e --reporter=list,html
```

Target after the new migration: **34 integration cases**. Do not point automated
tests at the application DB. Apply the additive application migration separately
through the normal backup/release process (`pnpm db:migrate`); no reseed/reset.

Follow GITHUB_INTEGRATION.md to configure public HTTPS APP_URL, OAuth and the manual
per-repository hook. Check a real ping/new event returns 202, exact redelivery 200,
unsupported/wrong-repository/invalid signatures fail and disabled endpoint returns 404. Check the authorized delivery-list endpoint shows PENDING and that disconnect
cancels unfinished records without deleting receipts. Validate setup dialog, picker,
clipboard and explicit disconnect on desktop/mobile before UI acceptance. Exercise
workspace-member rejection and foreign project IDs with separate authenticated
accounts. No event should mutate a task. Real GitHub lifecycle/transfer reconciliation,
worker lease/retry behavior and task association belong to later phases.

## M3.2 execution verification — 2026-11-14

M3.1's real GitHub ping/push acceptance is user-reported and acknowledged. No existing
application receipts or data were modified here. M3.2 adds the separate worker only;
no M3.3 definitions or M3.4 task actions are included.

### Database and browser execution limits

Before migration, the shared isolation guard validated DATABASE_URL and
TEST_DATABASE_URL, then an extra exact-name check required `/devflow_test`. The
migration command printed only target host/port/name and invoked `prisma migrate
deploy` with that test URL. It failed with **P1001, localhost:5433 unreachable**.
An initial inline ESM helper import failed before invoking Prisma; using the
project's CommonJS/tsx convention fixed the helper. No migration reached PostgreSQL
and no migration was attempted against the application database.

`AI_API_KEY= node_modules/.bin/vitest run --config vitest.integration.config.ts`
executed suite setup and failed initial `$connect()` in all four DB files:
**4 suite setup failures, 47 tests skipped**. This includes 13 new processing cases;
none of their SQL/concurrency/assertion paths executed. No repeated infrastructure
probes were attempted. Test scope/recovery options constrain worker fixtures to
their own connection so tests cannot claim unrelated pending test records.

`DEBUG=pw:webserver AI_API_KEY= node_modules/.bin/playwright test --reporter=list,html`
failed availability checks with **connect EPERM 127.0.0.1:3100**, then webServer exit
code 1. **Zero browser cases executed**. Original trace directories were preserved
under `/tmp/devflow-m32-original-results` and restored to `test-results/`; they are
old artifacts, not new successful screenshots. No browser visuals or live GitHub/
Groq acceptance is claimed. AI keys remain disabled for these test invocations.

### Checks and development findings

Installed-binary equivalents are used because of the previously documented pnpm
store/auto-install restriction; no package install or dependency addition was needed.
Prisma generation/validation and schema-to-schema migration generation ran locally
without applying SQL. The standalone worker is separately compiled with
`tsc -p tsconfig.worker.json`; production executes emitted CommonJS through Node,
without requiring tsx/dotenv development dependencies.

Targeted A/B/C compatibility/worker/linking suites passed after each phase. D exposed
and corrected leaking mock response queues; a later workflow-reference regression
caught an omitted reference assignment and was fixed. TypeScript caught a schema
union narrowing problem and an incomplete fixture assertion; both were fixed before
final checks. These intermediate failures are not hidden or classified as passes.
Final pass/fail counts follow at the end of this section.

### Fedora-local migration and verification

Use the existing separate URLs in `.env` and a reachable PostgreSQL instance on the
configured port. Never substitute the application URL for the test URL or reset it.

```bash
# Validates isolation and applies pending migrations to devflow_test without resets.
pnpm db:prepare:test
pnpm db:generate
pnpm github:worker:build
pnpm typecheck
pnpm typecheck:core
pnpm lint
pnpm test
pnpm build:webpack
AI_API_KEY= pnpm test:integration
# No development server may occupy port 3100; Playwright owns its test DB server.
AI_API_KEY= pnpm test:e2e --reporter=list,html
```

After the **47 DB cases** pass, review/back up application data and manually apply
the additive application migration through your normal configured release process:

```bash
pnpm db:migrate       # prisma migrate deploy; no reset, push or seed
pnpm db:generate
pnpm github:worker:build
GITHUB_WORKER_CONNECTION_ID=your_connection_id pnpm github:worker --once
```

Confirm that connection ID belongs to the intended workspace/project and repository
`jameelsikandar/25-react-projects`. Existing PENDING version-1 ping/push require no
redelivery. Confirm ping PROCESSED/no TaskActivity and push object/reference results
without task-field/version changes. Missing DEV references mean no associations.
Then verify continuous worker supervision/SIGTERM, two-worker competition, stale
lease/disconnect races and optional enrichment with explicit OAuth authorization.
Inspect desktop/mobile status filters, retry controls, task navigation, incomplete
observations and both themes. These manual gates remain open until actually run.
See GITHUB_INTEGRATION.md for rate/cooldown, queue states, partial-data, once exit-code
and credential/lifecycle limitations. No GitHub App installation is implemented.

### Final executed M3.2 results

| Check                                                                  | Actual result                                                 |
| ---------------------------------------------------------------------- | ------------------------------------------------------------- |
| `node_modules/.bin/prisma validate`                                    | Passed                                                        |
| `node_modules/.bin/prisma generate`                                    | Passed, client 6.19.0                                         |
| Guarded `prisma migrate deploy` with verified `/devflow_test` override | Blocked: P1001, no SQL applied                                |
| `node_modules/.bin/tsc --noEmit` after final Next build                | Passed                                                        |
| `node_modules/.bin/tsc --noEmit -p tsconfig.core.json`                 | Passed                                                        |
| `node_modules/.bin/tsc -p tsconfig.worker.json`                        | Passed; standalone worker emitted                             |
| `node_modules/.bin/eslint .`                                           | Passed                                                        |
| `AI_API_KEY= node_modules/.bin/vitest run`                             | **239 passed in 27 files**                                    |
| `AI_API_KEY= node_modules/.bin/next build --webpack`                   | Passed                                                        |
| Changed TS/TSX/JSON/Markdown Prettier check                            | Passed; one request-test formatting difference corrected      |
| PostgreSQL integration                                                 | **4 setup failures, 47 skipped**; zero DB assertions executed |
| Playwright desktop/mobile                                              | **0 executed**, server startup/localhost EPERM restriction    |

No live GitHub enrichment, Groq requests or actual worker application-data processing
was performed. The compiled worker was built, not started against the application
DB. Real SQL/lease behavior and deployment acceptance remain explicitly unverified.

## M3.2 padded reference / existing-commit reconciliation — 2026-11-14

The exact-message regression exercises `test: verify DevFlow task linking DEV-002`
through push normalization, stored-event parsing, canonicalization and the scoped
Task.number-2 lookup. Alias dedupe and positive-number validation are covered. The
source confirms raw messages are discarded; live JSON was not inspected here and
no live reconciliation was executed. Authenticated GitHub recovery uses the actual
commit API, never the user's supplied message as a mutation input.

The new reconciliation tests mock GitHub/database boundaries; they are not live or
transactional acceptance. Two real-PostgreSQL cases were added to the existing worker
suite to verify padded references and idempotent repair with unchanged task fields,
receipt status, objects and observation JSON/count. They allocate fixture task numbers
without modifying sequences or existing task 2.

Before the integration attempt, the shared isolation guard and exact-name check
printed only `localhost 5433 /devflow_test`. The suite setup failed initial Prisma
connections with `Can't reach database server at localhost:5433`: **4 setup failures,
49 skipped tests**. No DB assertions executed and no fixture writes reached a DB.
The target remains the isolated test database. No migration/reset/seed is required
for this fix. No application database read/write was attempted in this repair.

Use the current commands in GITHUB_INTEGRATION.md to run the isolated suite locally,
deploy/restart both Next.js and rebuilt worker, authorize the caller's own enrichment
and POST the targeted commit reconciliation request. Existing processed delivery
retry remains prohibited; immutable observations and replay protection are preserved.
Final available-check results are appended below after execution.

Final available results for this repair: **248 unit tests passed in 29 files**;
full/core TypeScript, ESLint, standalone worker compilation and webpack production
build passed. Changed-file formatting passed. PostgreSQL attempt: **4 setup failures,
49 skipped**, no executed DB assertions. Browser execution was not requested or
reattempted for this backend/parser-only fix. No schema, dependency or UI changes.
No live GitHub/Groq calls, application DB queries/writes or reconciliation ran here.

## Latest M3.2 task GitHub UI verification — 2026-11-14

The user's existing DEV-002 / 9023d37 association was not modified. New UI/API reads
use existing models; no migration or reprocessing is necessary. Tests never used the
application database. The isolation guard plus exact-name check printed target
`localhost 5433 /devflow_test` before test execution.

| Check                                                                                   | Actual result                                            |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `AI_API_KEY= node_modules/.bin/vitest run`                                              | **257 passed, 31 files**                                 |
| `node_modules/.bin/tsc --noEmit` after webpack                                          | Passed                                                   |
| `node_modules/.bin/tsc --noEmit -p tsconfig.core.json`                                  | Passed                                                   |
| `node_modules/.bin/tsc -p tsconfig.worker.json`                                         | Passed                                                   |
| `node_modules/.bin/eslint .`                                                            | Passed                                                   |
| `AI_API_KEY= node_modules/.bin/next build --webpack`                                    | Passed                                                   |
| Changed TS/TSX/CSS/Markdown Prettier checks                                             | Passed after fixing one test formatting difference       |
| `AI_API_KEY= node_modules/.bin/vitest run --config vitest.integration.config.ts`        | **4 setup failures; 52 skipped**                         |
| `DEBUG=pw:webserver AI_API_KEY= node_modules/.bin/playwright test --reporter=list,html` | **0 cases executed**; localhost EPERM / webServer exit 1 |

The DB failure occurs at initial Prisma `$connect()`: localhost:5433 is unreachable.
None of the three added GitHub visibility DB cases or earlier DB cases executed
assertions/fixture writes. No database migration/reset/seed or application DB queries
were attempted. Playwright failed availability checks with `connect EPERM
127.0.0.1:3100`, before browser launch/assertions. Original trace directories were
backed up under `/tmp/devflow-task-github-original-results` and restored beneath
test-results. No new task-dialog screenshots or visual acceptance are claimed.

New executed cases: five service/URL/status tests and four mounted UI tests. They
cover membership/task scope, redaction, disconnected/unavailable metadata, safe URL
construction, stored-state labels, all four kinds in the actual TaskDialog, existing
form/comment/close controls, loading/error/empty/retry, both theme contexts, unsafe
API URL rejection, passive card opening and preserved drag grip. DOM theme assertions
do not verify rendered contrast/responsive layout. TypeScript initially found the
unavailable Lucide `Github` export; the existing app's `GitFork as Github` convention
was reused and the final checks passed.

Three written DB cases check actual associations/card counts and unchanged task data,
foreign task/workspace access, disconnected history and pagination. One browser journey
runs in both desktop/mobile projects (eight total suite cases now), with real isolated
registration/task CRUD plus intercepted activity/count UI fixtures. It includes safe
links, both-theme screenshots, dialog controls and keyboard drag cancellation. That
fixture is not live GitHub or real-association persistence acceptance.

Run locally after starting the existing PostgreSQL instance and ensuring separate
application/test URLs (`TEST_DATABASE_URL` names devflow_test):

```bash
# Only if the isolated test schema needs preparation; never resets it:
pnpm db:prepare:test
pnpm typecheck
pnpm typecheck:core
pnpm lint
pnpm test
pnpm build:webpack
AI_API_KEY= pnpm test:integration
# Keep port 3100 free; Playwright starts its own isolated test server.
AI_API_KEY= pnpm test:e2e --reporter=list,html
```

After deploying/restarting the updated Next.js app, open Board → DevFlow → DEV-002,
then scroll within the existing dialog to GitHub activity below editor/comments.
Confirm commit 9023d37 and repository jameelsikandar/25-react-projects and its GitHub
link. Refresh an already-open Board to obtain the new association count, or wait for
its existing 30-second snapshot refresh. Verify both themes and narrow viewport;
no new commit, OAuth request, worker execution or reconciliation is needed to read
an already-existing link. No M3.3/M3.4 work is included.

## M3.3 — GitHub workflow definitions/dry runs (2026-11-15)

Implementation is complete; PostgreSQL migration/integration and browser acceptance
remain open. M3.4 is not implemented. No task field or existing observation was
changed, and no application database migration/reset/reseed was performed.
No live GitHub/Groq request was made. Existing test-results/report artifacts were
backed up under `/tmp/devflow-m33-original-*` and restored after the blocked run.
No new screenshots were captured. Git metadata is unavailable, so no commit made.

### Executed checks

Installed binaries were run directly because the sandbox's pnpm installation/store
policy is restricted. These are the equivalents of the requested pnpm scripts.

| Check                        | Command actually executed                                                                              | Actual result                                                               |
| ---------------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| Schema validation            | `node_modules/.bin/prisma validate`                                                                    | Passed                                                                      |
| Client generation            | `node_modules/.bin/prisma generate`                                                                    | Passed                                                                      |
| Schema formatting            | `node_modules/.bin/prisma format`                                                                      | Passed                                                                      |
| Full TypeScript              | `node_modules/.bin/tsc --noEmit --pretty false`                                                        | Passed                                                                      |
| Core TypeScript              | `node_modules/.bin/tsc --noEmit -p tsconfig.core.json --pretty false`                                  | Passed                                                                      |
| ESLint                       | `node_modules/.bin/eslint .`                                                                           | Passed                                                                      |
| Unit/DOM regression          | `node_modules/.bin/vitest run`                                                                         | **301 passed, 34 files**                                                    |
| Worker compilation           | `node_modules/.bin/tsc -p tsconfig.worker.json --pretty false`                                         | Passed                                                                      |
| Production webpack           | `node_modules/.bin/next build --webpack` (after client generation)                                     | Passed                                                                      |
| Changed TS/TSX/CSS/JSON/docs | `node_modules/.bin/prettier --check` with explicit changed-file paths                                  | Passed                                                                      |
| Test-only migration          | Guarded Node wrapper → Prisma `migrate deploy`, overriding DATABASE_URL only for verified devflow_test | **Blocked: P1001**, cannot reach localhost:5433; no migration applied       |
| PostgreSQL suites            | `node_modules/.bin/vitest run --config vitest.integration.config.ts`                                   | **5 suites fail at connection setup; all 61 tests skipped, 0 passed**       |
| Playwright desktop/mobile    | `node_modules/.bin/playwright test --reporter=list,html`                                               | **0 browser tests executed**; configured webServer could not start (exit 1) |

The test target was explicitly validated as `localhost:5433/devflow_test`, distinct
from the configured application database, using `requireTestDatabase` before the
migration attempt. The integration config enforces the same isolation boundary.
The PostgreSQL failure is a connection/setup blocker, not evidence that migration,
foreign-key or concurrency assertions passed. Playwright failed before browser
assertions; its output did not provide a more specific server error. Earlier
sandbox socket `EPERM` limitations are recorded above; no bypass was attempted.

44 new unit/DOM cases cover trigger/state validation, padded references, immutable
inputs/repeated previews, disabled-rule simulation, priority conflicts, no-op status,
repo scoping, stale/future timestamps, inconsistent projections, duplicate/missing/
ambiguous/incomplete/disconnected facts, malformed JSON, admin checks, strict command
validation, idempotency/version/audit contracts and actual dialog interactions.
The 9 new PostgreSQL cases (unexecuted) cover database scope constraints, concurrent
idempotent creates, concurrent version conflicts, soft-delete/audit history,
read-only task preservation, observation evidence, duplicate facts, stale/disconnected
and legacy data, plus authenticated API/origin enforcement. The new Playwright
journey (two projects, unexecuted) exercises real rule CRUD/persistence, history,
explicit enable, task preservation and both-theme screenshots. Existing AI/webhook/
worker/roadmap regressions remain in the full suites.

### Safe Fedora verification

Keep `DATABASE_URL` pointing at your application and set `TEST_DATABASE_URL` to the
separate `devflow_test` database in the ignored `.env`. Do not point both at the
same database. These steps never reset or reseed either database.

```bash
# Validate only the isolated target; prints no credentials.
node --import tsx -e 'require("dotenv/config"); const {requireTestDatabase}=require("./tests/database-config.ts"); const u=requireTestDatabase(process.env.DATABASE_URL,process.env.TEST_DATABASE_URL); if(u.pathname!=="/devflow_test")throw Error("Only devflow_test permitted"); console.log("Verified isolated test database",u.pathname.slice(1));'

# Creates devflow_test only if absent, then deploys pending migrations there.
pnpm db:prepare:test
pnpm exec prisma validate
pnpm db:generate
pnpm typecheck
pnpm typecheck:core
pnpm lint
pnpm test
pnpm github:worker:build
pnpm build:webpack
AI_API_KEY= pnpm test:integration
# Stop any conflicting server on 3100. Playwright starts its own isolated server,
# clears AI_API_KEY and refuses non-local origins/reuse of an existing server.
AI_API_KEY= pnpm test:e2e --reporter=list,html
```

Expected discovery: 301 unit/DOM tests; 61 integration tests (9 new); 10 Playwright
cases across desktop/mobile (2 new). Discovery is not a pass. Require actual local
success before declaring database/browser gates closed. Review generated screenshots
at desktop/mobile and both themes; no horizontal page overflow, accessible dialog
focus/close, scrollable content, compact project-card controls, usable status/trigger
selects and composer/Assistant layout unchanged.

The changed-file formatting command (SQL uses explicit reviewed migration text;
Prisma uses its own formatter) is:

```bash
pnpm exec prettier --check src/lib/github-workflows.ts src/lib/server/github-workflows.ts src/components/github-workflow-settings.tsx src/components/workspace-views.tsx 'src/app/api/[...path]/route.ts' src/app/globals.css tests/github-workflows.test.ts tests/github-workflows-server.test.ts tests/github-workflows-interface.test.ts tests/github-workflows.integration.test.ts e2e/github-workflows.spec.ts tsconfig.core.json UPGRADE_PLAN.md UPGRADE_REPORT.md VERIFICATION.md GITHUB_INTEGRATION.md
```

Only after isolated migration/tests succeed, manually deploy the application
migration during your normal deployment window:

```bash
# Intentional manual application deployment; additive, no reset or seed.
pnpm db:migrate
pnpm db:generate
pnpm dev
```

This applies `202611150001_github_workflow_definitions`: two new tables, one trigger
enum, indexes/composite scope/version/request constraints and check constraints.
Existing task/webhook/object/evidence rows are retained. A new composite connection
index can briefly lock repository-connection metadata during deployment; plan for
normal migration locking. Rehearse on devflow_test first. No server worker restart
or GitHub webhook reconfiguration is required by M3.3 itself.

Manual preview: Projects → DevFlow → Workflow rules; create “PR merged → Done”
disabled; select a real merged-PR observation with DEV-002 evidence; include disabled
rules in hypothetical preview; click Preview only. Existing commit 9023d37 is not
a PR trigger. If no matching PR observation exists, the empty/blocked state is
correct. See GITHUB_INTEGRATION.md for full scope/conflict/freshness semantics.

## M3.4 — safe GitHub status automation (2026-11-15)

Implementation is present; PostgreSQL/browser/live acceptance remains open. The
following supersedes M3.3's historical statement that enabling rules never executes.
M3.3 previews remain read-only. No live rule/PR/task was changed by this run.

| Check                               | Actual executed command                                                              | Result                                                                     |
| ----------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| Schema validation/generation/format | `node_modules/.bin/prisma validate`, `generate`, `format`                            | Passed                                                                     |
| Full TypeScript                     | `node_modules/.bin/tsc --noEmit --pretty false`                                      | Passed                                                                     |
| Core TypeScript                     | `node_modules/.bin/tsc --noEmit -p tsconfig.core.json --pretty false`                | Passed                                                                     |
| ESLint                              | `node_modules/.bin/eslint .`                                                         | Passed                                                                     |
| Unit/DOM                            | `node_modules/.bin/vitest run`                                                       | **323 passed, 36 files**                                                   |
| Worker build                        | `node_modules/.bin/tsc -p tsconfig.worker.json --pretty false`                       | Passed                                                                     |
| Webpack production                  | `node_modules/.bin/next build --webpack` after Prisma generation                     | Passed                                                                     |
| Changed-file formatting             | `node_modules/.bin/prettier --check` with paths listed below                         | Passed                                                                     |
| Offline migration/schema diff       | Prisma `migrate diff` plus additive DDL/default checks                               | Passed; not a PostgreSQL migration test                                    |
| Isolated migration                  | Guarded `migrate deploy` with DATABASE_URL overridden only to validated devflow_test | **Blocked, P1001**, localhost:5433 inaccessible                            |
| PostgreSQL integration              | `node_modules/.bin/vitest run --config vitest.integration.config.ts`                 | **6 suites fail in connection hooks; all 82 tests skipped, 0 passed**      |
| Playwright                          | `DEBUG=pw:webserver node_modules/.bin/playwright test --reporter=list,html`          | **0 browser tests executed**; connect EPERM 127.0.0.1:3100, server exits 1 |
| E2E discovery                       | `node_modules/.bin/playwright test --list`                                           | 12 cases in 5 files, not a browser pass                                    |

Installed binaries are equivalent to pnpm scripts; pnpm's auto-install/store policy
is restricted in this sandbox. The migration wrapper used `requireTestDatabase`
and required exactly `/devflow_test`, printing only host/port/name. Application
DATABASE_URL was never used for migrations/tests. No reset, drop, reseed or live
GitHub/Groq call occurred. Original test-results and Playwright-report artifacts
were backed up under `/tmp/devflow-m34-original-*` and restored. No new screenshots
were captured. Git metadata is unavailable, so no milestone commit was made.

22 additional unit/DOM cases cover real executor branching with mocked database
boundaries, status/other-field preservation, null-human actor, duplicate prevention,
rollback/retry and exhaustion, rule/task/connection/authorization conflicts, source
identity/activation-version boundaries, confirmation cancellation/consent and safe
monitoring links. The 21 new PostgreSQL cases (unexecuted) cover actual worker
publication/action stages, unique effects, competing workers, transaction abort
before commit, bounded failure records, old pending and already-processed receipts,
legacy enabled rules, dry-run preservation, age/boundary checks, conflicts, workspace
isolation/FKs, revoked roles, admin operations and audit/activity atomicity.
The new browser journey covers confirmation, history/source inspection and mocked
post-automation Kanban/activity snapshots. Those fixtures are explicitly UI-only;
they do not demonstrate a real GitHub event or actual automated database mutation.
Existing AI/roadmap/webhook/task UI suites remain included in the full checks.

### Fedora-local isolated verification

Keep the ignored `.env` DATABASE_URL pointing to the application database and
TEST_DATABASE_URL to a distinct database named **devflow_test**. First validate the
target (no secrets printed), then deploy migrations only there:

```bash
node --import tsx -e 'require("dotenv/config"); const {requireTestDatabase}=require("./tests/database-config.ts"); const u=requireTestDatabase(process.env.DATABASE_URL,process.env.TEST_DATABASE_URL); if(u.pathname!=="/devflow_test")throw Error("Only devflow_test permitted"); console.log("Verified isolated test database",u.pathname.slice(1));'
pnpm db:prepare:test
pnpm exec prisma validate
pnpm db:generate
pnpm typecheck
pnpm typecheck:core
pnpm lint
pnpm test
pnpm github:worker:build
pnpm build:webpack
AI_API_KEY= pnpm test:integration
# No competing server on 3100. Playwright refuses an existing server and starts
# its own server with TEST_DATABASE_URL and an empty AI_API_KEY.
AI_API_KEY= pnpm test:e2e --reporter=list,html
```

Require actual successful execution, not discovery: 323 unit/DOM, 82 PostgreSQL
and 12 desktop/mobile browser cases. Inspect generated screenshots in both themes,
confirmation cancel/accept, legacy preview-only labels, execution history filters,
safe links and task activity. The historical roadmap/browser release gates are
not retroactively declared passed by this change.

Changed-file formatting (Prisma uses its own formatter; SQL is reviewed separately):

```bash
pnpm exec prettier --check src/lib/github-automation.ts src/lib/types.ts src/lib/server/github-automation.ts src/lib/server/github-automation-monitoring.ts src/lib/server/github-workflow-evaluation.ts src/lib/server/github-workflows.ts src/lib/server/github-repositories.ts src/lib/server/github-job.ts src/lib/server/github-worker-runtime.ts src/lib/server/tasks.ts src/lib/server/task-status.ts 'src/app/api/[...path]/route.ts' src/components/github-workflow-settings.tsx src/components/workspace-views.tsx src/components/devflow.tsx src/components/task-dialog.tsx src/app/globals.css tests/github-automation.test.ts tests/github-automation-monitoring.test.ts tests/github-automation.integration.test.ts tests/github-workflows-server.test.ts tests/github-workflows-interface.test.ts tests/github-workflows.integration.test.ts e2e/github-workflows.spec.ts e2e/github-automation.spec.ts tsconfig.core.json UPGRADE_PLAN.md UPGRADE_REPORT.md VERIFICATION.md GITHUB_INTEGRATION.md
```

### Manual application deployment and acceptance

Only after isolated tests pass, stop old web/worker replicas and manually apply:

```bash
# Deliberate application deployment, additive only. Never reset/push/seed.
pnpm db:migrate
pnpm db:generate
pnpm github:worker:build
pnpm build:webpack
pnpm dev
# Separate terminal/service:
pnpm github:worker
# Optional bounded work (counts both delivery and automation stages):
pnpm github:worker --once
```

The new migration is `202611150002_github_workflow_execution`. It adds execution
provenance/snapshots/states/uniqueness/FKs, historical-default delivery marker 0,
nullable rule activation time/authorizer/version, and explicit machine activity
source/receipt with nullable human actor. Existing rows/history are retained. New
indexes and constraints may briefly lock metadata/activity tables; rehearse against
devflow_test and use the normal migration deployment window. No live application
migration was performed in this sandbox.

Follow **GITHUB_INTEGRATION.md → M3.4 → Live acceptance — NEW PR referencing DEV-002**.
Start with DEV-002 Todo; record version/other fields and old PR #1 receipts. Confirm
the rule in the UI (normally creates v2, preserving v1), then create/merge a NEW PR
referencing DEV-002. Check 202 → delivery PROCESSED → execution APPLIED → task Done
with one GitHub automation activity/version increment. Redeliver only the NEW event
and verify no second effect; old PR #1 remains unexecuted. Restarting/enabling rules
must never enqueue historical processed observations. The agent did not perform
those live operations or claim acceptance based on mocked tests.

## M3.4 follow-up — transaction-spy integration repair (2026-11-15)

Both reported failure groups came from reflection-based spying on the Prisma
client's proxy `$transaction` method. Its readable function has an own property
descriptor value of undefined. The one-shot spy therefore had no genuine fallback
for the failure-accounting transaction, and cleanup restored an undefined method.
This explains both PENDING/0/null and the thirteen later broken-client fixtures.
The behavior was reproduced locally without connecting to any database.

Replaced both transaction spies with a scoped explicit-restore abort helper. It
still aborts after real transaction callback writes and before commit. The helper
restores the real method before the worker's failure handler can run and in finally;
no production transaction code or retry expectations were weakened. Tests additionally
assert that the callback reached APPLIED/STATUS_CHANGED before rollback. Live rule
configuration and all application data remain untouched. No schema migration needed.

| Check                     | Actual command/result                                                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Unit regression           | `node_modules/.bin/vitest run`: **326 passed, 37 files**                                                                                   |
| Focused automation/helper | `node_modules/.bin/vitest run tests/transaction-abort.test.ts tests/github-automation.test.ts`: **20 passed**                              |
| Full/core TypeScript      | `node_modules/.bin/tsc --noEmit --pretty false` and `node_modules/.bin/tsc --noEmit -p tsconfig.core.json --pretty false`: passed          |
| ESLint                    | `node_modules/.bin/eslint .`: passed                                                                                                       |
| Client/build              | `node_modules/.bin/prisma generate`, `node_modules/.bin/next build --webpack`: passed                                                      |
| Formatting                | Prettier check on the five changed files: passed                                                                                           |
| PostgreSQL integration    | Guarded `AI_API_KEY=` Vitest integration run against **localhost:5433/devflow_test**: **6 connection-hook failures, 82 skipped, 0 passed** |

The Fedora results establish that PostgreSQL and all seven migrations work locally
for the user. This sandbox still cannot reach that database (Prisma initialization
error at localhost:5433). The actual 82 SQL assertions therefore remain unexecuted
here; no migration/reset/reseed, alternate application database or live automation
was used as a workaround. Browser tests were not rerun for this test-only repair.

From the repository on Fedora, keep DATABASE_URL and TEST_DATABASE_URL distinct in
the ignored .env. No migration command is needed for these changes:

```bash
node --import tsx -e 'require("dotenv/config"); const {requireTestDatabase}=require("./tests/database-config.ts"); const u=requireTestDatabase(process.env.DATABASE_URL,process.env.TEST_DATABASE_URL); if(u.pathname!=="/devflow_test")throw Error("Only devflow_test permitted"); console.log("Verified isolated test database",u.pathname.slice(1));'
AI_API_KEY= pnpm test:integration
pnpm test
pnpm typecheck
pnpm typecheck:core
pnpm lint
pnpm build:webpack
pnpm exec prettier --check tests/transaction-abort.ts tests/transaction-abort.test.ts tests/github-automation.integration.test.ts UPGRADE_REPORT.md VERIFICATION.md
```

The integration suite still contains 82 tests; the three additional cases belong
to the unit suite. Require an actual local 82/82 integration result before closing
the database gate. Keep live rules disabled; these commands neither start the live
worker nor submit a GitHub event. Enabled automation fixtures exist only inside the
isolated test database and are cleaned up with their test-owned workspace records.
