# M3.5 operational acceptance checklist

**Status: implementation through Step 8 is committed; Step 9 documentation is
prepared. M3.5 acceptance remains OPEN.** This checklist does not authorize a push,
merge, deployment, worker start, new webhook, rule enablement or DEV-002 change.
Runbooks describe future operator actions. Preserve existing connections/rules/task
history; use a separately approved disposable scope for active fault/live tests.

## Evidence ledger — 2026-11-18

| Step | Delivered change                 | Commit / evidence                                                                                      | Remaining acceptance                                                     |
| ---- | -------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| 1    | Baseline and acceptance gates    | f1a1a2b; initial 326 unit cases; separate format-only f101e28                                          | Historical baseline, not current test totals                             |
| 2    | Durable scoped worker signals    | 8fbdc3e; covered by current owner SQL suite                                                            | Real supervised interruption/restart evidence still open                 |
| 3    | Administrator health API         | fb5d5b0; covered by owner SQL suite                                                                    | Real browser role/scope acceptance still open                            |
| 4    | Health in existing GitHub panel  | e3f6ecf; owner observed Healthy idle and Unavailable                                                   | Browser automation/other evidence classifications remain open            |
| 5    | Explicit connection revalidation | 09a32aa; owner verified repository/admin access with no retargeting/automation change                  | Failure lifecycle is mocked/SQL-tested; no fresh live revocation claimed |
| 6    | Read-only retention impact       | 1373a87; owner accepted rendered counts/ages/preservation; included in current SQL run                 | Browser acceptance and deployment-specific performance evidence open     |
| 7    | Failure/recovery journeys        | df10219; owner recovery file 6/6; included in current full SQL suite                                   | Fixtures model interruption; no real process-kill recovery claimed       |
| 8    | Isolated CI verification         | ecee52a; owner full SQL **124/124, 11 files** and unit/HTTP/DOM **476, 49 files**; static/build passed | Workflow reviewed, **GitHub-hosted run not executed**                    |
| 9    | Deployment/acceptance runbooks   | This documentation change; no commit hash assigned before owner commit                                 | Owner review/commit and outstanding operational gates                    |

Owner-reported Step 8 TypeScript, ESLint, formatting, Prisma validation/generation,
worker compilation and isolated webpack build passed. These are owner-local results,
not a new sandbox execution or hosted CI. Earlier 117/117 was a pre-Step-7 baseline;
Step 7 added six recovery-file cases **plus one revalidation-file cooldown case**.
The current actual full 124/124 result supersedes that unresolved full-suite gate.
Browser tests and live Groq acceptance have not been established by these results.

### Implementation and safety review

- [x] All nine implementation/doc areas have deliverables; Step 9 awaits its local commit.
- [x] Same PostgreSQL queue, fencing and separate worker architecture; no Redis/new service.
- [x] Health distinguishes fresh continuous polling from bounded or insufficient evidence.
- [x] Admin-only scope guards; no secrets/raw payloads in operational summaries.
- [x] Revalidation is explicit, identity-preserving and uses the permitted caller's authorization.
- [x] Retention remains read-only, with dependency/preservation rules and incomplete results.
- [x] Current owner-run isolated SQL 124/124 and unit/HTTP/DOM 476 results are recorded.
- [ ] Step 9 documentation reviewed and committed by owner; record actual SHA.
- [ ] Target deployment's eight-migration status verified before rollout; retain target evidence.
- [ ] Backup/key recovery rehearsal and artifact/schema-compatible rollback plan approved.
- [ ] GitHub-hosted CI on the final reviewed branch SHA passes; record run URL/SHA/results.
- [ ] Playwright chromium/mobile suites actually execute and pass; retain reports/traces.
- [ ] Desktop/mobile visual/keyboard/theme inspection records screenshots and observed defects.
- [ ] Separately authorized live operational and disposable automation journeys below completed.
- [ ] Release owner reviews unresolved limitations and explicitly closes M3.5 acceptance.

Checking an implementation box is not a claim of live operational acceptance.

## Local automated and browser gate

Use only the already migrated local devflow_test; never prepare/reset/reseed the
application database. Commands below are for the owner, not executions by this doc
change. No new migration is needed. In the repository:

```bash
node --import tsx <<'NODE'
require('dotenv/config');
const { requireTestDatabase } = require('./tests/database-config.ts');
const target = requireTestDatabase(process.env.DATABASE_URL, process.env.TEST_DATABASE_URL);
if (target.pathname !== '/devflow_test' ||
    !['localhost', '127.0.0.1'].includes(target.hostname) || target.port !== '5433')
  throw Error('Expected the reviewed local localhost:5433/devflow_test target');
console.log('Verified isolated target', target.hostname, target.port, target.pathname);
NODE
# Continue only after successful guard; no migration/reset/seed is needed for Step 9.
AI_API_KEY= GITHUB_CLIENT_ID= GITHUB_CLIENT_SECRET= pnpm test:integration
AI_API_KEY= GITHUB_CLIENT_ID= GITHUB_CLIENT_SECRET= pnpm exec vitest run --pool=forks
pnpm typecheck
pnpm typecheck:core
pnpm lint
pnpm format:check
pnpm exec prisma validate
pnpm github:worker:build
# Build in a separate release copy or stop dev first: do not share .next output.
pnpm build:webpack
# Chromium installation may require network/system packages; perform intentionally.
pnpm exec playwright install chromium
AI_API_KEY= GITHUB_CLIENT_ID= GITHUB_CLIENT_SECRET= pnpm test:e2e --reporter=list,html
```

If your isolated local port intentionally differs, review and adjust the guard's
port explicitly; never substitute a hosted or application database. Playwright's
existing config also validates distinct test/database names, starts its own local
HTTP server at 127.0.0.1:3100, refuses reuse, and uses chromium and iPhone-13-sized
mobile Chromium projects. Keep that port free and isolate .next from any dev server.
The mobile project is not native Safari. Integration mocks and browser fixtures
are not live GitHub/Groq acceptance. Unit DOM tests are not Playwright.

Inspect e2e/github-health.spec.ts, github-automation.spec.ts, github-workflows.spec.ts,
task-github.spec.ts, agent.spec.ts and workspace.spec.ts via the normal suite.
Retain failure traces/error-context before fixes; do not increase timeouts blindly.
No executed test count may be taken from --list discovery. Existing reports,
traces, screenshots and environment files stay ignored and private.

## Safe GitHub Actions acceptance and review

The workflow has ordinary pull_request plus main/conventional branch push triggers.
It has contents:read permission, SHA-pinned actions, nonpersistent checkout
credentials, frozen pnpm install and a lockfile/build-policy download-store cache.
It does not deploy, start a worker, enable rules or require repository secrets.

1. Obtain the owner's **explicit push approval**, separately from approval to commit
   Step 9. Confirm branch, clean tree, final SHA, reviewed diff and remote destination
   jameelsikandar/devflow. Do not force-push or modify history.
2. Only after that approval, push the feature branch (not main). Example future command:

```bash
# NOT authorized to execute by this checklist alone.
git push --set-upstream origin feat/m3-5-operational-readiness
```

3. Open GitHub Actions → **Isolated verification** → **Types, tests and production
   build** for that SHA. Check Node/pnpm versions, ephemeral postgres:16 health,
   guarded migration deployment, schema/client, formatting/lint/core types, worker
   compilation, 476 unit cases and 124 integration cases (or explain reviewed later
   count changes), webpack and full generated-route types. Every required stage
   must execute; cancelled/skipped/failed jobs do not pass. Record URL/SHA/date/counts.
4. CI uses devflow_test at loopback5432 and an unreachable application sentinel;
   never give it local/hosted/production URLs or OAuth/AI secrets to repair failures.
   See [verification troubleshooting](../VERIFICATION.md) for stage-specific help.
5. For a failure, retain sanitized logs, reproduce using mocks/devflow_test, make a
   focused fix commit and rerun checks. Obtain further push approval for that fix.
   Do not amend/rebase/force-push. A new SHA requires new CI evidence.
6. Open a pull request only when separately authorized, review all changes and
   outstanding manual gates, then merge **only with explicit owner approval**. No
   automatic merge, branch protection change or required-check configuration is
   performed by this milestone. A successful CI run alone does not close M3.5.

## Manual operational acceptance — separately approved test scope

Before active testing, record an approval, operator, release SHA, disposable
workspace/project/repository/connection/task/rule IDs and UTC times. Do not reuse
DEV-002, existing repository credentials or live rules without new explicit
permission. Do not revoke a real user's grant or interrupt the application DB.
Use a dedicated staging/test deployment for supervised outage/fault injection.

| Journey                          | Acceptance criteria / evidence to retain                                                                                                                                                                                                                                                                                                  |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deployment/migrations            | Reviewed target and eight applied migrations, backups/key continuity and web/worker artifact SHAs. No data reset or secret rotation.                                                                                                                                                                                                      |
| Continuous idle and active       | Fresh heartbeat plus fresh poll gives Healthy idle; genuinely accepted new work progresses and shows Active/progress. Zero backlog alone is not availability proof.                                                                                                                                                                       |
| Graceful stop / outage / restart | Approved staging worker SIGTERM drains; unexpected termination ages evidence to Unavailable, expires/reclaims leases and recovers without stale-owner publication or duplicate effects. Record process/supervisor evidence, not only fixture results.                                                                                     |
| Bounded and unknown evidence     | An isolated --once run shows bounded history, not continuous health. No signal/fresh heartbeat without poll is insufficient evidence. A stale existing continuous run may take precedence as Unavailable; do not fake/erase signal rows.                                                                                                  |
| Authorization/isolation          | Member and foreign-workspace requests denied; admin panels match selected project/connection; role loss clears sensitive UI. Capture sanitized status codes, no credentials.                                                                                                                                                              |
| Revalidation                     | With authorized external-read permission, verify own token/admin repository access. Existing identity/settings do not change. Revocation/permission/rate-limit journeys use disposable credentials or mocks, never another user's authorization. 401 does not prove expired versus revoked; 404 does not prove deletion.                  |
| Webhook / retries / dead letters | Approved new signed test event accepted/durably processed; controlled transient faults schedule bounded retry, permanent faults dead-letter; only explicit eligible failed-delivery retry recovers. Do not clear receipts or force historical replay.                                                                                     |
| Automation / replay              | Explicitly approved NEW PR in disposable scope with confirmed enabled rule updates only intended status/version/completion semantics and one machine activity/audit. Duplicate delivery/restart produces no duplicate effect; old observations remain preview-only. Test priority/task-version conflicts without overwriting human edits. |
| Retention                        | 7/30/90 windows, ages, exact-boundary behavior, dependency preservation and incomplete/empty/error states understood; no deletions/archive/scheduling occur. Browser and performance evidence separate from SQL fixtures.                                                                                                                 |
| UI regressions                   | Desktop/mobile, dark/light, keyboard navigation, readable errors/stale/loading states; existing Board/Tasks/roadmap, AI approvals/Quick Drafts and GitHub task links work. Capture screenshots only after rendering.                                                                                                                      |

The historical [DEV-002 acceptance procedure](../GITHUB_INTEGRATION.md) remains
reference context, not current permission to alter that task or enable its rule.
Live Groq acceptance is also separate, quota-dependent and not required for mocked
CI; it remains unverified unless the owner supplies actual evidence.

## Evidence record and release decision

For every outstanding journey record: operator/date; approved scope; commit SHA;
command/action; expected/observed result; test pass/fail/skip totals; sanitized
report/run/screenshot location; and unresolved risk. Keep sensitive incident data
outside public Git commits. Do not leave template checkboxes checked without evidence.

Known limits: custom auth lacks MFA/password recovery; classic OAuth uses broad repo
scope; health is PostgreSQL as-of evidence with no external alerting; retention is
analysis only and may be incomplete above its cap; polling/SSE and DB pools require
capacity planning. CI uses PostgreSQL16 while local Compose18 needs separate
operational compatibility review. No live deployment/restore/process-interruption
or final browser/hosted-CI acceptance was performed during documentation work.

**Do not mark M3.5 complete until required outstanding acceptance is recorded and
reviewed. Step 9 implementation/commit and milestone release acceptance are separate.**
