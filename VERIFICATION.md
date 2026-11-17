# DevFlow local verification

## Current change — M3.5 step 8: isolated CI verification (2026-11-18)

Confirmed df10219 on feat/m3-5-operational-readiness with a clean working tree and
index before edits. No application source/schema/lockfile change, migration
application, worker start or live provider operation was performed.

### Evidence reconciliation

Owner-reported Step 6 full PostgreSQL baseline: **117/117 across 10 files**.
Owner-reported Step 7 operational recovery file: **6/6 passed**. Inspection and
Vitest discovery confirm six cases in github-operational-recovery.integration.test.ts,
plus one Step 7 addition in github-revalidation.integration.test.ts (cooldown expiry
and an explicit subsequent check). Thus the historical “seven new cases” refers to
two files, not seven recovery-file cases. The extra cooldown case is not established
as passed by the six-case owner result. Current full discovery is **124 cases across
11 files**; no updated full PostgreSQL pass is inferred from discovery or arithmetic.

### CI workflow and isolation

.github/workflows/ci.yml runs on ordinary pull requests (including fork PRs) and
pushes to main and feat/fix/chore/refactor/test/docs branch prefixes. No
pull_request_target, deployment, schedule, live event or workflow-writing token is
used. Concurrency cancels superseded runs for the same workflow/ref; a cancelled
run is not a pass. Token permissions are contents:read, all actions are pinned to
reviewed release commit SHAs and checkout has persist-credentials:false.

A fresh GitHub-hosted ubuntu-24.04 runner uses Node 22.23.1 and package.json's
pnpm 11.9.0. Install is pnpm install --frozen-lockfile with the existing
pnpm-workspace.yaml build allowlist. Only the pnpm download store is cached; its
exact key includes runner OS, Node/pnpm major and hashes of the lockfile and build
policy. No .env, node_modules, generated Prisma/.next/.worker, reports, credentials
or database volumes are cached. Dependency installation and the public action/image
pulls need registry/network availability; this is separate from live provider access.

The postgres:16 service exposes only 127.0.0.1:5432 and creates devflow_test with a
health check. Its public ci_fixture_only password is a throwaway CI fixture, never
a repository secret or production credential. There is no persistent volume, dump
restore or application database. A deliberately unreachable DATABASE_URL at
127.0.0.1:1/devflow_ci_unused is the default for non-integration checks/builds.
TEST_DATABASE_URL is the exact loopback service devflow_test URL.

scripts/ci-verification.ts refuses migration/integration commands unless CI,
GITHUB_ACTIONS and RUNNER_ENVIRONMENT indicate a GitHub-hosted run and **both**
URLs exactly match the service/sentinel contract. This prevents accidental local,
self-hosted, hosted-database and query-parameter routing; it is a configuration
safety guard, not a security boundary against malicious repository code. It also
reuses requireTestDatabase's distinct-name/\_test guard. Migration deployment alone
receives DATABASE_URL=devflow_test. Integration keeps both names distinct so the
existing Vitest config can validate and then select devflow_test before loading
fixtures. No fallback/reset/seed/db-push is allowed. Subprocess errors/signals and
nonzero exits fail the job; diagnostics do not print configured URLs or thrown errors.

Required stages: frozen install; Prisma validation/generation; guarded migrate
deploy; Prettier; ESLint; core types; worker compilation only; unit/HTTP/DOM tests
with forks; guarded real PostgreSQL integration; webpack production build; full
types including generated Next.js route types. No continue-on-error is permitted.
GitHub/AI client keys are blank and AI_BASE_URL is an unreachable loopback fixture;
existing tests inject provider responses. No live worker or credential-dependent
acceptance is run. Browser acceptance remains a separate gate; Step 8 does not add
Playwright installation/execution or claim that DOM unit tests replace browsers.

Reviewed upstream references for maintenance: [setup-node](https://github.com/actions/setup-node),
[pnpm/action-setup v4.2.0 inputs](https://github.com/pnpm/action-setup/blob/v4.2.0/action.yml),
[GitHub runner environment variables](https://docs.github.com/en/actions/reference/workflows-and-actions/variables).
Update pins deliberately alongside packageManager/Node and CI contract tests.

### Actual sandbox verification

| Check                 | Actual command / result                                                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Unit/HTTP/DOM         | AI_API_KEY= GITHUB_CLIENT_ID= GITHUB_CLIENT_SECRET= node_modules/.bin/vitest run --pool=forks: **476 passed, 49 files, 0 failed**, including 22 new CI cases |
| Full/core types       | node_modules/.bin/tsc --noEmit --pretty false; node_modules/.bin/tsc --noEmit -p tsconfig.core.json --pretty false: passed                                   |
| Post-build full types | Same full check in the build source snapshot after Next route type generation: passed                                                                        |
| ESLint                | node_modules/.bin/eslint .: passed                                                                                                                           |
| Schema/client         | DATABASE_URL=non-live-placeholder node_modules/.bin/prisma validate and prisma generate: passed; no migration or SQL                                         |
| Worker                | node_modules/.bin/tsc -p tsconfig.worker.json --pretty false: passed; no worker started                                                                      |
| Formatting            | node_modules/.bin/prettier --check . and git diff --check: passed                                                                                            |
| Production            | node_modules/.bin/next build --webpack in credential-free source snapshot: passed                                                                            |
| CLI rejection         | CI=false GITHUB_ACTIONS=false node --import tsx scripts/ci-verification.ts migrate: refused with exit 1 before spawning Prisma, as intended                  |
| PostgreSQL            | Loopback 127.0.0.1:5433 TCP probe returned EPERM. SQL integration/migration execution **not performed**; no connection retries/workarounds                   |
| Integration discovery | vitest list --config vitest.integration.config.ts --json: **124 discovered / 11 files**, zero SQL assertions executed; not passes                            |
| Hosted workflow       | **Not run**: no push or remote action authorized; fresh install, cache, service/migration/job acceptance await an actual run                                 |
| Browser/live services | **Not executed** in this step; no browser/screenshot or real GitHub/Groq acceptance claimed                                                                  |

Initial focused test run caught a comment-sensitive secret-reference assertion;
it now checks parsed YAML. Full types caught a missing NODE_ENV in the test-only
environment fixture; corrected before the final passing run. Production source
needed no change. YAML contract parsing reuses ESLint's installed, lockfile-resolved
js-yaml dependency; no new package was installed. This checks local syntax and
security requirements, not GitHub's hosted workflow execution.

Build snapshot: /tmp/devflow-m35-ci-build-8rpnwaci. Copied tracked/new source without
private .env or generated files and linked existing installed dependencies.
Build used blank AI/GitHub client keys, unreachable AI_BASE_URL and DATABASE_URL
at 127.0.0.1:1/devflow_build_test, APP_URL=http://localhost:3000 and disabled Next
telemetry. Existing application .next/dev output was not altered. Logs:
/tmp/devflow-m35-ci-unit.log and /tmp/devflow-m35-ci-build.log. Integration discovery:
/tmp/devflow-m35-ci-integration-discovery.json. These temporary artifacts are not committed.

### Fedora verification and CI troubleshooting

Use the existing migrated isolated database. Do not run the CI-only wrapper locally
or spoof its hosted flags; no new migration is needed for Step 8. Stop at a failed
safety guard, and never substitute the application URL as the test URL.

```bash
node --import tsx <<'NODE'
require('dotenv/config');
const { requireTestDatabase } = require('./tests/database-config.ts');
const target = requireTestDatabase(process.env.DATABASE_URL, process.env.TEST_DATABASE_URL);
if (target.pathname !== '/devflow_test') throw Error('Only devflow_test permitted');
console.log('Verified isolated test target', target.hostname, target.port, target.pathname);
NODE
# Continue only after successful guard. No reset, seed or migration is needed here.
AI_API_KEY= GITHUB_CLIENT_ID= GITHUB_CLIENT_SECRET= pnpm test:integration
AI_API_KEY= GITHUB_CLIENT_ID= GITHUB_CLIENT_SECRET= pnpm exec vitest run --pool=forks
pnpm typecheck
pnpm typecheck:core
pnpm lint
pnpm format:check
pnpm exec prisma validate
pnpm github:worker:build
# Stop the dev server or build a separate source checkout to avoid sharing .next.
pnpm build:webpack
```

For hosted CI, after separately approving and performing a push, inspect the
**Isolated verification / Types, tests and production build** run. Record its URL,
commit SHA, runner versions and actual test totals before claiming acceptance.
No repository/environment secrets need configuration. Do not add production secrets
to make tests pass. Branch protection/required checks are not configured by this step.

- Service unhealthy: inspect the ephemeral postgres container health log in the job;
  verify the service database/user/port. Never point CI at another database.
- Guard failure: compare only the checked-in public service/sentinel configuration
  and hosted runner type. Do not relax the guard or introduce secret URL overrides.
- Locked install/build-script failure: reconcile packageManager, lockfile and
  allowBuilds intentionally; do not use --no-frozen-lockfile or approve arbitrary scripts.
- Cache/registry outage: rerun after availability recovers; there is no broad restore
  key or build-artifact cache. A cache miss performs a normal frozen installation.
- Migration/schema error: retain the failed log and fix/rehearse a forward migration;
  never reset/reseed, edit applied migration history or target the application database.
- Unit/integration/type/build failure: reproduce the named stage locally using mocks
  and devflow_test. Connection-hook skips/failures are not passing SQL assertions.
- Browser/live acceptance: still requires the separate authorized procedures; no
  hosted pass closes M3.5's required live operational gates automatically.

Prepared commit: chore: add isolated CI verification. **Stop for owner commit
confirmation before Step 9. M3.5 is not complete.**

## Historical change — M3.5 step 7: failure/recovery journeys (2026-11-18)

Verified 1373a87 and a clean feat/m3-5-operational-readiness. At this handoff the
owner reports Step 6 PostgreSQL **117/117 passed across 10 files**, 441 unit tests,
healthy Docker PostgreSQL, working retention reports and browser acceptance pending.
That is owner-run evidence for the committed baseline, not a sandbox run or proof
that the newly added PostgreSQL cases pass.

### Actual execution in this step

| Check                          | Command                                                                                       | Result                                                                                                       |
| ------------------------------ | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Full unit/HTTP/DOM suite       | AI_API_KEY= GITHUB_CLIENT_ID= GITHUB_CLIENT_SECRET= node_modules/.bin/vitest run --pool=forks | **454 passed, 48 files, 0 failed**; 13 new cases                                                             |
| Focused failure/recovery suite | vitest run --pool=forks on operations-recovery, revalidation and retention test files         | **61 passed**, 5 files                                                                                       |
| Full/core TypeScript           | tsc --noEmit; tsc --noEmit -p tsconfig.core.json                                              | Passed                                                                                                       |
| ESLint                         | node_modules/.bin/eslint .                                                                    | Passed                                                                                                       |
| Prisma schema validation       | node_modules/.bin/prisma validate                                                             | Passed; schema unchanged                                                                                     |
| Worker compilation             | node_modules/.bin/tsc -p tsconfig.worker.json --pretty false                                  | Passed; no worker process started                                                                            |
| Webpack production build       | Installed Next next build --webpack in source snapshot below                                  | Passed                                                                                                       |
| Formatting/diff                | node_modules/.bin/prettier --check .; git diff --check                                        | Passed                                                                                                       |
| Playwright discovery           | node_modules/.bin/playwright test e2e/github-health.spec.ts --list                            | **2 cases discovered**, zero executed; not browser passes                                                    |
| PostgreSQL                     | Not executed in this sandbox step                                                             | Seven new cases written (six cross-layer journeys, one cooldown recovery); no new DB pass/skip count claimed |
| Live services / screenshots    | Not executed                                                                                  | No real GitHub request, worker CLI/systemd start, SIGKILL, outage injection or screenshot acceptance claimed |

Only tests and documentation changed; application, schema, migration, worker,
service/API and task/automation source are unchanged. No dependency or environment
file changes. No live connection, rule, task, DEV-002 or provider event was touched.
The previously blocked sandbox DB/server checks were not repeatedly retried or
bypassed; a healthy owner-local container does not establish sandbox connectivity.
The 117-case owner run precedes the new seven cases and must not be relabeled as
execution of the updated suite.

Build source snapshot: /tmp/devflow-m35-recovery-build-khlsl4gk, copied tracked/new
source without private .env or generated output and symlinked installed dependencies.
The application source is identical to the working application. A non-live placeholder
DATABASE_URL at localhost:1/devflow_build_test, APP_URL=http://localhost:3000,
blank AI/GitHub client credentials and NEXT_TELEMETRY_DISABLED=1 were used. Existing
application .next/dev output and the owner's running server remained untouched.
Logs: /tmp/devflow-m35-recovery-unit.log, /tmp/devflow-m35-recovery-focused.log,
/tmp/devflow-m35-recovery-build.log.

### What the recovery evidence proves

New runtime unit tests use injected processors and in-memory telemetry storage,
fake timers and deferred gates: no DB/job process is started. They exercise startup
and abort boundaries, sibling draining, unavailable telemetry→fresh heartbeat with
stale poll→active work, graceful shutdown and failure bookkeeping/log sanitization.
Provider timeout tests manually abort the signal supplied through the real transport
and assert its configured 15-second bound; they do not wait 15 wall-clock seconds
or contact GitHub. Explicit subsequent calls must recover without changing connection
settings. Retention service/HTTP/UI failures cannot publish partial/zero-filled or
stale eligibility. Existing automation/AI/roadmap unit regressions remain passing.

New PostgreSQL tests use actual signed ingestion, leases, scoped runtime helpers,
health/retention services and fixture records. They test live lease status followed
by expired recovery, fenced old-owner completion/renewal/failure, backoff/dead letters,
explicit authorized retry, signed/body replay protection, unchanged task/version/
disabled-rule snapshots and sanitized authorization/isolation. A separate cooldown
case expires only its test metadata key before an explicit provider recheck.

These database journeys are **unexecuted here**. They model interruption by stale
RUNNING evidence and abandoned lease fields, not by killing an OS worker. A controlled
telemetry flush samples DB state without sleeps; unit tests separately exercise
actual timer/coalescing behavior. In-process fixture runtime uses a fresh explicit
connection ID and bounded/abort controls, never a live/default-global worker.
A future owner run must distinguish SQL fixture recovery from real service-manager,
container, network and live webhook acceptance.

The existing browser journey adds unavailable→idle, rejected authorization→explicit
valid result, and incomplete/error retention→complete fixtures. Requests are mocked;
no automatic revalidation or resource mutation is permitted. Discovery/TypeScript
are not proof of native keyboard, responsive, screenshot or real authorization behavior.
Coverage references are indexed in GITHUB_INTEGRATION.md.

### Safe Fedora verification for the updated suite

Use existing migrated devflow_test, not the application database. No new migration,
reset, seed or service configuration is required. First validate the target:

```bash
node --import tsx <<'NODE'
require('dotenv/config');
const { requireTestDatabase } = require('./tests/database-config.ts');
const target = requireTestDatabase(process.env.DATABASE_URL, process.env.TEST_DATABASE_URL);
if (target.pathname !== '/devflow_test') throw Error('Only devflow_test permitted');
console.log('Verified isolated test target', target.hostname, target.port, target.pathname);
NODE
# Continue only after the guard succeeds.
AI_API_KEY= GITHUB_CLIENT_ID= GITHUB_CLIENT_SECRET= pnpm exec vitest run --config vitest.integration.config.ts tests/github-operational-recovery.integration.test.ts tests/github-revalidation.integration.test.ts
AI_API_KEY= GITHUB_CLIENT_ID= GITHUB_CLIENT_SECRET= pnpm test:integration
AI_API_KEY= GITHUB_CLIENT_ID= GITHUB_CLIENT_SECRET= pnpm exec vitest run --pool=forks
pnpm typecheck
pnpm typecheck:core
pnpm lint
pnpm format:check
pnpm exec prisma validate
pnpm github:worker:build
# Stop the local dev server or use a separate source copy to isolate .next output.
# Keep 3100 free: Playwright must start its own isolated server.
AI_API_KEY= GITHUB_CLIENT_ID= GITHUB_CLIENT_SECRET= pnpm test:e2e e2e/github-health.spec.ts --reporter=list,html
AI_API_KEY= GITHUB_CLIENT_ID= GITHUB_CLIENT_SECRET= pnpm test:e2e --reporter=list,html
AI_API_KEY= GITHUB_CLIENT_ID= GITHUB_CLIENT_SECRET= pnpm build:webpack
```

Fixtures create fresh users/workspaces/projects/connections and a disabled rule/task
snapshot. Failure timing is controlled by fixture-only fields or deferred gates,
not sleeps. Cleanup uses only those fixture IDs. Provider fetch is mocked or rejects
unexpected requests; no live credentials are required. No application database,
existing enabled/disabled rule or DEV-002 is a fixture. No standalone worker command
is needed or authorized by these test instructions.

Prepared commit: `test: cover operational failure and recovery journeys`. Wait
for owner commit confirmation before Step 8. No Git staging/commit/push was attempted.
M3.5 remains open until required updated DB/browser/live operational gates execute.

## Historical change — M3.5 step 6: read-only retention impact (2026-11-18)

Verified 09a32aa on feat/m3-5-operational-readiness and a clean starting tree. Owner
manual evidence: working worker-health UI, correct idle/unavailable distinction,
repository/admin-access revalidation, and no retargeting/automation changes. This
is manual owner evidence, not agent-executed PostgreSQL/browser acceptance.

### Actual checks

| Check                      | Executed command                                                                              | Result                                                                                                                                                                                                         |
| -------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full TypeScript            | node_modules/.bin/tsc --noEmit --pretty false                                                 | Passed                                                                                                                                                                                                         |
| Core TypeScript            | node_modules/.bin/tsc --noEmit -p tsconfig.core.json --pretty false                           | Passed                                                                                                                                                                                                         |
| Worker compilation         | node_modules/.bin/tsc -p tsconfig.worker.json --pretty false                                  | Passed; no worker started                                                                                                                                                                                      |
| ESLint                     | node_modules/.bin/eslint .                                                                    | Passed                                                                                                                                                                                                         |
| Prisma schema              | node_modules/.bin/prisma validate                                                             | Passed; schema unchanged                                                                                                                                                                                       |
| Full unit/HTTP/DOM suite   | AI_API_KEY= GITHUB_CLIENT_ID= GITHUB_CLIENT_SECRET= node_modules/.bin/vitest run --pool=forks | **441 passed, 47 files, 0 failed**; 13 policy/service, 3 HTTP and 8 UI cases added                                                                                                                             |
| Webpack production build   | next build --webpack in isolated source copy below                                            | Passed                                                                                                                                                                                                         |
| Repository formatting/diff | node_modules/.bin/prettier --check .; git diff --check                                        | Passed                                                                                                                                                                                                         |
| Playwright discovery       | node_modules/.bin/playwright test e2e/github-health.spec.ts --list                            | **2 cases discovered**, not executed; journey now includes retention preview and table overflow checks                                                                                                         |
| PostgreSQL integration     | Not executed                                                                                  | **11 new database cases unexecuted**. The known guarded sandbox probe could not reach devflow_test; it was not repeatedly retried. No SQL/runtime/performance or read-only-engine pass is inferred from mocks. |
| Browser/live actions       | Not executed                                                                                  | No screenshots, actual responsive/keyboard acceptance, live GitHub request or worker run claimed                                                                                                               |

The first DOM loading assertion ran before React Query's batched notification; it
was corrected to wait for the disabled pending state rather than sleeping or
weakening the assertion. Final focused and full suites pass. Existing authorization,
GitHub/AI/roadmap/replay/worker regressions remain passing in the unit suite.

Build source copy: /tmp/devflow-m35-retention-build-ifzd8ggk, tracked/new files only,
no private .env or generated output, symlinked installed node_modules. The build
used blank AI/GitHub credentials, NEXT_TELEMETRY_DISABLED=1,
APP_URL=http://localhost:3000 and a non-live placeholder DATABASE_URL at
localhost:1/devflow_build_test. Dynamic routes required no provider/database calls.
The application .next/dev output and running server were untouched.
Logs: /tmp/devflow-m35-retention-unit.log and /tmp/devflow-m35-retention-build.log.
No dependency, lockfile, schema, migration, configuration policy or environment-file
change was introduced. No app/test database write, seed, reset, cleanup, archive,
scheduler, worker, provider action or DEV-002 operation was performed here.

### Coverage and limitations

Executed cases check administrator enforcement before aggregates; readonly/timeout
transaction commands; 7/30/90 windows and invalid inputs; grouped counts/age ranges;
dependency overlap; fail-closed caps; scope-bound parameterized metadata queries;
replay/audit-preserving policy; missing/future age data; strict GET/no execution
route; session/membership/admin and no-store behavior; UI loading/empty/error/retry,
role/scope/window reset, private field omission, partial reports and theme/table
semantics. DOM theme/keyboard semantics do not establish visual acceptance.

Real SQL tests use the same query factory with a fixed clock for exact cutoff
boundaries, so the 1ms-before/equal/after checks do not race a wall clock. Additional
PostgreSQL cases cover complete provenance/FKs and unchanged domain rows,
active/unresolved states, worker anchors including an older progress-bearing run,
disconnected history/isolation, 10,001-row overflow and an attempted isolated write
rejected by PostgreSQL READ ONLY. They are written but **not executed**. Query
plans, runtime and timeout behavior require local verification; no constant disk
scan bound is claimed from the matched-row limit.

Each category scans at most 10,001 matched metadata rows before deciding whether
analysis is complete. Exact totals/ages/candidate counts are null above 10,000;
no sample is presented as a complete result. Server output is bounded groups, not
record lists. Existing scoped/FK indexes and 4s statement/15s transaction budgets
bound expensive requests; actual planner work can vary. Source payload JSON,
credentials, raw task refs and private error text are not selected into the app.

### Safe Fedora-local verification

Use the existing dedicated devflow_test with the reviewed prior migrations. No
Step 6 migration or seed is needed. Do not run these fixtures on application data.

```bash
node --import tsx <<'NODE'
require('dotenv/config');
const { requireTestDatabase } = require('./tests/database-config.ts');
const target = requireTestDatabase(process.env.DATABASE_URL, process.env.TEST_DATABASE_URL);
if (target.pathname !== '/devflow_test') throw Error('Only devflow_test permitted');
console.log('Verified isolated test target', target.hostname, target.port, target.pathname);
NODE
# Continue only if the guard succeeds:
AI_API_KEY= GITHUB_CLIENT_ID= GITHUB_CLIENT_SECRET= pnpm exec vitest run --config vitest.integration.config.ts tests/github-retention.integration.test.ts
AI_API_KEY= GITHUB_CLIENT_ID= GITHUB_CLIENT_SECRET= pnpm test:integration
AI_API_KEY= GITHUB_CLIENT_ID= GITHUB_CLIENT_SECRET= pnpm exec vitest run --pool=forks
pnpm typecheck
pnpm typecheck:core
pnpm lint
pnpm format:check
pnpm exec prisma validate
pnpm github:worker:build
# Stop the local dev server or use a separate source copy to isolate .next output.
# Keep port 3100 free; Playwright must start its own isolated test server.
AI_API_KEY= GITHUB_CLIENT_ID= GITHUB_CLIENT_SECRET= pnpm test:e2e e2e/github-health.spec.ts --reporter=list,html
AI_API_KEY= GITHUB_CLIENT_ID= GITHUB_CLIENT_SECRET= pnpm build:webpack
```

The large-scope SQL case inserts 10,001 fresh test receipts in bounded batches and
cleans only its fixture workspace. The read-only-enforcement case attempts an update
only to its newly created devflow_test fixture inside a read-only transaction and
asserts rollback/unchanged state. No application data or existing rules are touched.
Provider fetch is stubbed to reject unexpected requests. Browser fixtures mock
GitHub, health, revalidation and retention responses; they do not prove live
provider/SQL authorization. Inspect generated screenshots and overflow at four
widths locally; none were captured here.

Manual inspection: existing GitHub project → GitHub event processing → Retention
impact report → proposed 7/30/90 days → Generate read-only report. Verify timestamp
bases, preserved replay/audit records, incomplete versus empty reports and lack of
cleanup actions. Reporting needs no OAuth token, live GitHub request or worker.

Prepared commit: `feat(ops): add read-only retention impact reports`. Wait for the
owner commit before step 7. Retention execution is not implemented or authorized;
M3.5 PostgreSQL/browser/final operational acceptance gates remain open.

## Historical change — M3.5 step 5: explicit connection revalidation (2026-11-17)

Verified e3f6ecf on feat/m3-5-operational-readiness and a clean starting tree. Owner
manual evidence: application worker-health migration applied, schema current,
healthy-idle UI with recent heartbeat/completed poll and zero pending/failed/dead
letters. This is not an agent-executed integration suite or live revalidation.

### Actual checks

| Check                         | Executed command                                                                              | Result                                                                                                                                                                                          |
| ----------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full TypeScript               | node_modules/.bin/tsc --noEmit --pretty false                                                 | Passed                                                                                                                                                                                          |
| Core TypeScript               | node_modules/.bin/tsc --noEmit -p tsconfig.core.json --pretty false                           | Passed                                                                                                                                                                                          |
| Worker compilation            | node_modules/.bin/tsc -p tsconfig.worker.json --pretty false                                  | Passed; worker not started                                                                                                                                                                      |
| ESLint                        | node_modules/.bin/eslint .                                                                    | Passed                                                                                                                                                                                          |
| Full unit/route/DOM suite     | AI_API_KEY= GITHUB_CLIENT_ID= GITHUB_CLIENT_SECRET= node_modules/.bin/vitest run --pool=forks | **417 passed, 44 files, 0 failed**; 24 service, 3 HTTP and 15 UI cases added                                                                                                                    |
| Webpack build                 | next build --webpack in isolated source copy below                                            | Passed                                                                                                                                                                                          |
| Repository formatting/diff    | node_modules/.bin/prettier --check .; git diff --check                                        | Passed                                                                                                                                                                                          |
| Browser discovery             | node_modules/.bin/playwright test e2e/github-health.spec.ts --list                            | **2 cases discovered**; zero executed. Existing journey now includes a mocked explicit diagnostic action.                                                                                       |
| PostgreSQL integration        | Not executed here                                                                             | Eight new isolated database cases written; no pass/skip count claimed. Known prior guarded sandbox probe could not reach devflow_test; no prohibited retry or application connection attempted. |
| Live GitHub / browser visuals | Not executed                                                                                  | No OAuth/provider, repository, webhook, live worker or screenshot acceptance claimed.                                                                                                           |

No schema migration, dependency or environment-example change is needed. All provider
requests in unit/database/browser fixtures are mocked; the unit run clears live
AI/GitHub client variables. No live credential was loaded or used for a request.
No application migration, seed, reset, connection/rule change or DEV-002 operation
was performed. At runtime the action writes only existing operational rate-limit
budgets/cooldowns; domain records and provider resources are never changed.

Build snapshot: /tmp/devflow-m35-revalidation-build-nn1fr01i. Tracked/new source was
copied without private .env files or generated output, and installed node_modules
was symlinked. Build used blank AI/GitHub client credentials,
NEXT_TELEMETRY_DISABLED=1, APP_URL=http://localhost:3000 and the non-live placeholder
DATABASE_URL at localhost:1/devflow_build_test. No database/provider connection was
needed. The existing application .next/dev output and local server were untouched.
Logs: /tmp/devflow-m35-revalidation-unit-final.log and
/tmp/devflow-m35-revalidation-build.log. Package/lockfile/schema are unchanged.

### Executed coverage and honest limitations

Unit cases validate own-account/configured-grant selection, no other member token
lookup/fallback, identity preservation, admin/foreign scope denial, missing/partial
configuration, HTTP 401/403/404/5xx, redirects, malformed/network failures, permission
true/false/missing evidence, account/repository identity changes, header Retry-After/
reset timing versus no timing, local cooldown reuse, changed credentials/grants,
disconnect/role-loss races and local budget rejection. External requests are bounded
GETs; runtime code never holds a database transaction open during network reads.
No test fabricates distinct expired/revoked proof: existing OAuth schema stores no
expiry evidence, and 401 alone is deliberately AUTHORIZATION_REJECTED.

HTTP cases verify same-origin POST, empty strict body, authenticated actor, membership/
admin protection, no GET action, no-store and sanitized errors. UI cases verify no
mount/reconnect/background checks, explicit loading and retry, no offline queue,
admin-only visibility, scope reset/mismatch, fixed diagnostic copy, known-deadline
waiting and missing-deadline behavior. Existing GitHub/AI/roadmap/worker tests still
pass. These are mocks/DOM checks, not real GitHub or PostgreSQL concurrency evidence.

Eight new PostgreSQL cases cover scoped real authorization, unchanged domain rows,
other-authorizer restrictions, credential/grant/disconnect/role-change races,
observed cooldown persistence, identity/permission failures and atomic request
budgets. They have not executed here. The extended browser fixture permits only
the explicit diagnostic POST and asserts none occurs before the click; it is not
server authorization or provider acceptance. No screenshots were captured.

### Safe Fedora-local verification

Use the existing ignored .env with distinct application/test URLs. Only devflow_test
is allowed for automated database/browser fixtures. Step 5 adds no migration or seed.

```bash
node --import tsx <<'NODE'
require('dotenv/config');
const { requireTestDatabase } = require('./tests/database-config.ts');
const target = requireTestDatabase(process.env.DATABASE_URL, process.env.TEST_DATABASE_URL);
if (target.pathname !== '/devflow_test') throw Error('Only devflow_test permitted');
console.log('Verified isolated test target', target.hostname, target.port, target.pathname);
NODE
# Continue only if the guard succeeds; use the already-reviewed migrated test schema.
AI_API_KEY= GITHUB_CLIENT_ID= GITHUB_CLIENT_SECRET= pnpm exec vitest run --config vitest.integration.config.ts tests/github-revalidation.integration.test.ts
AI_API_KEY= GITHUB_CLIENT_ID= GITHUB_CLIENT_SECRET= pnpm test:integration
AI_API_KEY= GITHUB_CLIENT_ID= GITHUB_CLIENT_SECRET= pnpm exec vitest run --pool=forks
pnpm typecheck
pnpm typecheck:core
pnpm lint
pnpm format:check
pnpm github:worker:build
# Stop the local dev server first or use a separate source copy for build/E2E output.
# Keep 3100 free; Playwright must start its own isolated server.
AI_API_KEY= GITHUB_CLIENT_ID= GITHUB_CLIENT_SECRET= pnpm test:e2e e2e/github-health.spec.ts --reporter=list,html
AI_API_KEY= GITHUB_CLIENT_ID= GITHUB_CLIENT_SECRET= pnpm build:webpack
```

Database fixtures create fresh local users/workspaces/projects/disabled rules;
cleanup is restricted to their IDs and rate-limit keys. They stub all provider
requests and never operate on live rules or DEV-002. Do not substitute the running
application server/database for the isolated test configuration.

For a separately deliberate owner-run live read, use an already authorized admin
session → GitHub → existing project → Connection revalidation. Read the consent
text and click Revalidate GitHub access only when you intend up to two external
GitHub GETs. If another authorizer owns enrichment, that administrator must check
it themselves. Verify checked source/time and unchanged repository identity/settings.
Do not rotate credentials, revoke grants, retarget repositories, register webhooks,
enable rules or alter tasks merely to test failure states; mocked suites cover those.
A successful metadata/admin check is not complete enrichment/webhook acceptance.
No live check was performed by the agent.

Prepared commit: `feat(github): add explicit connection revalidation diagnostics`.
Wait for owner commit confirmation before step 6. No Git metadata write/push/merge
was attempted; M3.5 database/browser/live acceptance gates remain open.

## Historical change — M3.5 step 4: administrator health panel (2026-11-17)

Confirmed fb5d5b0 on feat/m3-5-operational-readiness and a clean starting tree.
This step displays the Step 3 API inside the existing GitHub event-processing
panel. No backend route/service, schema, migration, worker, rule or task mutation
is changed. Application records, connections and DEV-002 remain untouched.

### Actual checks

| Check                      | Executed command                                                                              | Result                                                                                                                                      |
| -------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Full TypeScript            | node_modules/.bin/tsc --noEmit --pretty false                                                 | Passed                                                                                                                                      |
| Core TypeScript            | node_modules/.bin/tsc --noEmit -p tsconfig.core.json --pretty false                           | Passed                                                                                                                                      |
| Worker compilation         | node_modules/.bin/tsc -p tsconfig.worker.json --pretty false                                  | Passed; no worker started                                                                                                                   |
| ESLint                     | node_modules/.bin/eslint .                                                                    | Passed after resolving the render-time Date.now purity issue using timer/event/request state updates                                        |
| Full unit/DOM/route suite  | AI_API_KEY= GITHUB_CLIENT_ID= GITHUB_CLIENT_SECRET= node_modules/.bin/vitest run --pool=forks | **375 passed, 41 files, 0 failed**; 22 new health-interface cases and one full-page member-visibility case                                  |
| Production build           | next build --webpack using isolated source snapshot described below                           | Passed                                                                                                                                      |
| Repository format/diff     | node_modules/.bin/prettier --check .; git diff --check                                        | Passed                                                                                                                                      |
| New browser discovery      | node_modules/.bin/playwright test e2e/github-health.spec.ts --list                            | **2 cases discovered** (chromium/mobile); zero browser tests executed                                                                       |
| PostgreSQL integration     | Not executed in this UI-only step                                                             | The prior guarded sandbox probe could not reach devflow_test; no new database evidence was supplied. Not retried, passed or marked skipped. |
| Browser screenshots/layout | Not executed                                                                                  | Visual acceptance remains incomplete. No screenshot, overflow or real keyboard/theme-layout pass is claimed from jsdom/discovery.           |

No repeated socket attempt or conflicting dev server was launched. The browser
journey requires isolated PostgreSQL for real registration/SSR authentication;
its GitHub/health responses are mocked UI fixtures. The known sandbox database/
server restriction was not bypassed. Step 3 owner-local integration results were
a placeholder, not actual acceptance counts, and remain unrecorded here.

Build copied tracked/new source into /tmp/devflow-m35-health-ui-build-nwuu_kig,
excluding private .env files and generated output, and symlinked installed
node_modules. The final component/tests were synced before the final build.
The build used blank AI/GitHub client credentials, NEXT_TELEMETRY_DISABLED=1,
APP_URL=http://localhost:3000, and the non-live placeholder DATABASE_URL at
localhost:1/devflow_build_test. No database or provider connection was required.
The owner's application .next/dev output and running server were left alone.
Logs: /tmp/devflow-m35-health-ui-unit-final.log and /tmp/devflow-m35-health-ui-build.log.
No dependency or lockfile change was made.

### UI regression evidence and remaining gates

Executed DOM cases cover all seven labels (five worker states plus disconnected/
archived), zero work, missing connection, loading, sanitized errors, generic-error
stale snapshots, snapshot aging/device clock difference, read-only polling/refresh,
collapsed guidance, unknown diagnostic/credential fields, malformed responses,
member hiding, role downgrade and strict response scope. Cached data requires a
successful scope-verified request on the current mount: a failed initial request
cannot disclose cached metrics, and a transport failure after access denial cannot
restore them. Existing retry/enrichment and connection/disconnect cases still pass.
Light/dark DOM semantics do not establish CSS contrast or pixel/layout correctness.

New Playwright journey checks the existing panel, native keyboard refresh, no
GitHub writes, generic refresh failure, 1440/1024/768/390 widths and dark/light,
and captures screenshots only when actually executed. Both configured browser
projects discover the journey. It is not live GitHub, worker or server authorization
acceptance, and no screenshots exist from this sandbox step.

### Safe Fedora-local verification

Use the existing distinct devflow_test configuration with Step 2 migration already
reviewed/applied to that isolated database. No Step 4 migration or seed is needed.
The guard below only validates configuration and prints a sanitized target.

```bash
node --import tsx <<'NODE'
require('dotenv/config');
const { requireTestDatabase } = require('./tests/database-config.ts');
const target = requireTestDatabase(process.env.DATABASE_URL, process.env.TEST_DATABASE_URL);
if (target.pathname !== '/devflow_test') throw Error('Only devflow_test permitted');
console.log('Verified isolated test target', target.hostname, target.port, target.pathname);
NODE
# Continue only after the guard succeeds:
AI_API_KEY= GITHUB_CLIENT_ID= GITHUB_CLIENT_SECRET= pnpm exec vitest run --pool=forks
pnpm typecheck
pnpm typecheck:core
pnpm lint
pnpm format:check
pnpm github:worker:build
AI_API_KEY= GITHUB_CLIENT_ID= GITHUB_CLIENT_SECRET= pnpm test:integration
# Stop the local dev server first, or use a separate source copy to isolate .next output.
# Keep 3100 free. Playwright must start its own isolated server (reuseExistingServer=false).
AI_API_KEY= GITHUB_CLIENT_ID= GITHUB_CLIENT_SECRET= pnpm test:e2e e2e/github-health.spec.ts --reporter=list,html
AI_API_KEY= GITHUB_CLIENT_ID= GITHUB_CLIENT_SECRET= pnpm test:e2e --reporter=list,html
AI_API_KEY= GITHUB_CLIENT_ID= GITHUB_CLIENT_SECRET= pnpm build:webpack
```

Inspect test-results screenshots from both projects and all requested sizes/themes.
The browser journey creates only a fresh isolated user/workspace/project, intercepts
all GitHub routes with read-only fixtures and does not create repository connections,
merge PRs, enable rules or start workers. Do not run against application data or a
reused application server. Actual authorization/database behavior remains covered
by the existing isolated integration suites, not these mocked browser responses.

Manual UI inspection: GitHub navigation → selected project → GitHub event processing
→ Operational health. Refresh reads only. Check empty/idle, bounded/unknown evidence,
backlog/failures, stale/error labels and role-based visibility without changing
existing rules or connections. No live external action is needed or authorized.

Prepared commit: `feat(github): display operational health in existing panels`.
Wait for the owner's commit confirmation before step 5. M3.5 completion and visual/
PostgreSQL/live operational acceptance remain open. No Git write/push was attempted.

## Historical change — M3.5 step 3: authorized summaries (2026-11-17)

Verified owner commit 8fbdc3e on feat/m3-5-operational-readiness and a clean tree
before implementation. The owner's restored-Fedora message includes the literal
placeholder `[INSERT RESULTS]`; actual integration counts were not supplied.
No owner-local PostgreSQL pass is inferred from that placeholder.

### Actual checks

| Check                     | Executed command                                                                              | Result                                                                                        |
| ------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Full TypeScript           | node_modules/.bin/tsc --noEmit --pretty false                                                 | Passed                                                                                        |
| Core TypeScript           | node_modules/.bin/tsc --noEmit -p tsconfig.core.json --pretty false                           | Passed                                                                                        |
| Worker compilation        | node_modules/.bin/tsc -p tsconfig.worker.json --pretty false                                  | Passed; no worker started                                                                     |
| ESLint                    | node_modules/.bin/eslint .                                                                    | Passed                                                                                        |
| Prisma schema             | node_modules/.bin/prisma validate                                                             | Passed; schema unchanged, no migration needed                                                 |
| Full unit/route/DOM suite | AI_API_KEY= GITHUB_CLIENT_ID= GITHUB_CLIENT_SECRET= node_modules/.bin/vitest run --pool=forks | **352 passed, 40 files, 0 failed**; includes 12 new summary/HTTP route cases                  |
| Webpack production build  | Installed Next binary: next build --webpack, in isolated source snapshot below                | Passed                                                                                        |
| Repository format/diff    | node_modules/.bin/prettier --check .; git diff --check                                        | Passed                                                                                        |
| PostgreSQL                | Guarded connection-only probe for exactly devflow_test                                        | Still unreachable at localhost:5433 from sandbox; **nine new integration cases not executed** |
| Browser/live              | Not run for this API-only step                                                                | No UI, browser acceptance, live worker or GitHub/Groq action claimed                          |

The probe used dotenv plus requireTestDatabase, required exactly /devflow_test,
and constructed a separate PrismaClient datasourceUrl from that validated URL.
Only $connect/$disconnect were attempted; it reported TEST_DATABASE_UNREACHABLE.
No migration, fixture, cleanup or application database write followed, and the
blocked connection was not repeatedly retried. Fedora health does not establish
sandbox socket accessibility. These are unexecuted tests, not passing/skipped counts.

To preserve the owner's running Next.js development output, tracked and new source
files were copied to /tmp/devflow-m35-summary-build-5z5irin\_, excluding private
.env files and generated artifacts. node_modules was symlinked for installed
dependencies; the application directory's .next was untouched. The successful
build used blank AI/GitHub client configuration, NEXT_TELEMETRY_DISABLED=1,
APP_URL=http://localhost:3000 and a non-live placeholder DATABASE_URL at
localhost:1/devflow_build_test. No database connection is needed for these dynamic
API routes. The initial build command used the wrong /tmp working directory and
exited 127 (binary not found); it was corrected to the source snapshot before the
successful build. No permission workaround or application config change was used.

Logs: /tmp/devflow-m35-summary-unit.log and /tmp/devflow-m35-summary-build.log.
Source/API behavior and tests passed with installed binaries equivalent to pnpm
scripts; no package, lockfile, schema or migration change was introduced.

### Safe Fedora-local verification

Use the existing distinct devflow_test configuration and the already-reviewed
step 2 migration. The following guard only inspects configuration and prints a
sanitized target; it never prints credentials or modifies either database.

```bash
node --import tsx <<'NODE'
require('dotenv/config');
const { requireTestDatabase } = require('./tests/database-config.ts');
const target = requireTestDatabase(process.env.DATABASE_URL, process.env.TEST_DATABASE_URL);
if (target.pathname !== '/devflow_test') throw Error('Only devflow_test permitted');
console.log('Verified isolated test target', target.hostname, target.port, target.pathname);
NODE
# Continue only if the guard succeeds and Step 2 migration is present in devflow_test.
AI_API_KEY= GITHUB_CLIENT_ID= GITHUB_CLIENT_SECRET= pnpm exec vitest run --config vitest.integration.config.ts tests/github-operational-health.integration.test.ts
AI_API_KEY= GITHUB_CLIENT_ID= GITHUB_CLIENT_SECRET= pnpm test:integration
AI_API_KEY= GITHUB_CLIENT_ID= GITHUB_CLIENT_SECRET= pnpm exec vitest run --pool=forks
pnpm typecheck
pnpm typecheck:core
pnpm lint
pnpm format:check
pnpm github:worker:build
```

No new migration is necessary. If Step 2's migration is missing, review its guarded
**isolated-database-only** command in that historical section; do not run a generic
application migration, reset or seed. No worker start is required for the nine
new integration cases: they create fresh isolated fixture rows and call read-only
services/HTTP handlers with mocked Next cookies. External fetch is forbidden.
They cover administrator/session authorization, cross-workspace/project/connection
isolation, many stalled replicas, bounded/stale/disconnected/archived evidence,
backoff/lease/dead-letter counts, automation aggregates and unchanged task/receipt
state. These tests are not live provider or browser acceptance.

For production build verification, first stop your local dev server or reproduce
the temporary source-snapshot approach, then run pnpm build:webpack with blank
AI/GitHub credentials. Do not launch another conflicting server or live worker.
The new no-store endpoint may be inspected in an existing authenticated owner/admin
browser session at /api/github/repositories/CONNECTION_ID/health?workspaceId=WORKSPACE_ID.
It performs no external requests, mutations or automatic retries. This step adds
no UI; step 4 waits for owner commit confirmation.

Prepared commit: `feat(github): expose authorized operational health summaries`.
No Git staging/commit/push is attempted in the read-only metadata sandbox. No live
rules, repository connections, DEV-002 or application records were changed.

## Historical change — M3.5 step 2: durable worker signals (2026-11-15)

Owner commits verified: f1a1a2b (baseline docs), f101e28 (formatting cleanup).
Branch feat/m3-5-operational-readiness and working tree were clean before this
change. Only the scoped health persistence/runtime/test/docs change is prepared;
no Git writes are attempted here. Wait for the owner commit before step 3.

### Actual checks

| Check                   | Executed command                                                                                                                      | Result                                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Prisma schema           | node_modules/.bin/prisma validate                                                                                                     | Passed                                                                                                                       |
| Prisma client           | node_modules/.bin/prisma generate                                                                                                     | Passed; no database writes                                                                                                   |
| Additive schema diff    | prisma migrate diff --from-schema-datamodel /tmp/devflow-m35-health-before.prisma --to-schema-datamodel prisma/schema.prisma --script | Passed; previous HEAD schema compared without a database. Only new enums/table/index/FKs; migration also adds two checks.    |
| Full TypeScript         | node_modules/.bin/tsc --noEmit --pretty false                                                                                         | Passed                                                                                                                       |
| Core TypeScript         | node_modules/.bin/tsc --noEmit -p tsconfig.core.json --pretty false                                                                   | Passed                                                                                                                       |
| Worker compilation      | node_modules/.bin/tsc -p tsconfig.worker.json --pretty false                                                                          | Passed; no worker started                                                                                                    |
| ESLint                  | node_modules/.bin/eslint .                                                                                                            | Passed                                                                                                                       |
| Full unit/DOM suite     | AI_API_KEY= GITHUB_CLIENT_ID= GITHUB_CLIENT_SECRET= node_modules/.bin/vitest run --pool=forks                                         | **340 passed, 38 files, 0 failed**; includes 14 new health cases                                                             |
| Production build        | AI_API_KEY= GITHUB_CLIENT_ID= GITHUB_CLIENT_SECRET= node_modules/.bin/next build --webpack                                            | Passed                                                                                                                       |
| Formatting/diff         | node_modules/.bin/prettier --check .; git diff --check                                                                                | Passed                                                                                                                       |
| PostgreSQL              | Guarded connection-only probe below                                                                                                   | Blocked: localhost:5433/devflow_test unreachable. Seven new integration cases **not executed**; no integration pass claimed. |
| Browser/live acceptance | Not run for this backend-only step                                                                                                    | Prior sandbox socket restriction remains; no visual/live acceptance claimed.                                                 |

One concurrent TypeScript attempt hit missing generated .next/types files while
webpack regenerated them. After build completion, full/core/worker TypeScript and
ESLint were rerun sequentially; the table records those final results. No config
or source change was made to conceal that check-order failure.

Installed binaries avoid the documented pnpm sandbox auto-install restriction;
no dependency or lockfile changes. Forked Vitest workers use the successful pool
from the preceding formatting change. Logs are /tmp/devflow-m35-health-unit-final.log,
/tmp/devflow-m35-health-build.log, and /tmp/devflow-m35-health-schema-diff.sql.

The probe loaded local dotenv configuration, validated distinct app/test database
names with requireTestDatabase, required pathname exactly /devflow_test, constructed
a separate PrismaClient with datasourceUrl set to that test URL, and attempted
only $connect/$disconnect. It reported TEST_DATABASE_UNREACHABLE. No migration,
reset, seed, application database connection, worker or external request was run.
No prohibited network workaround or repeated database attempt followed. The seven
new PostgreSQL cases remain unexecuted, not passed or an executed skip count.
Existing tests are also not rerun against an inaccessible database in this step.

### Fedora-local isolated verification

Use the existing ignored .env, with distinct DATABASE_URL and TEST_DATABASE_URL.
This fail-closed command applies additive migrations **only to devflow_test**;
it does not create, reset, seed or touch the application database. Review the new
migration before running it. The sandbox has not verified this DDL against a server.

```bash
node --import tsx <<'NODE'
require('dotenv/config');
const { requireTestDatabase } = require('./tests/database-config.ts');
const { spawnSync } = require('node:child_process');
const target = requireTestDatabase(process.env.DATABASE_URL, process.env.TEST_DATABASE_URL);
if (target.pathname !== '/devflow_test') throw Error('Only devflow_test permitted');
console.log('Verified isolated migration target', target.hostname, target.port, target.pathname);
const result = spawnSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
  env: { ...process.env, DATABASE_URL: target.href }, stdio: 'inherit',
});
if (result.error || result.status !== 0) process.exitCode = 1;
NODE
# Continue only if migration succeeded:
pnpm db:generate
AI_API_KEY= GITHUB_CLIENT_ID= GITHUB_CLIENT_SECRET= pnpm exec vitest run --config vitest.integration.config.ts tests/github-worker-health.integration.test.ts
AI_API_KEY= GITHUB_CLIENT_ID= GITHUB_CLIENT_SECRET= pnpm test:integration
AI_API_KEY= GITHUB_CLIENT_ID= GITHUB_CLIENT_SECRET= pnpm exec vitest run --pool=forks
pnpm typecheck
pnpm typecheck:core
pnpm lint
pnpm format:check
pnpm github:worker:build
AI_API_KEY= GITHUB_CLIENT_ID= GITHUB_CLIENT_SECRET= pnpm build:webpack
```

All new database fixtures are isolated and scoped to their test connection; they
stub external fetch and only process a fixture ping. The full integration suite
retains its existing test-database guard. Do not start a worker against application
data or apply the application migration as part of this test procedure. Only
consider manual application deployment after isolated verification and review.
Source migration 202611150003_github_worker_health is additive and empty on install;
old workers simply provide no health evidence until the updated worker is deployed.
No API/panel feature, destructive retention, automation rule enablement or M3.5
completion is claimed. See GITHUB_INTEGRATION.md for evidence state semantics.

## Historical baseline — M3.5 step 1 (2026-11-15)

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
