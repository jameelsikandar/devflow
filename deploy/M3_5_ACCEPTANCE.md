# M3.5 operational acceptance checklist

**Status: M3.5 implementation/runbooks and typography are squash-merged into main
at d21dc1a via [PR #1](https://github.com/jameelsikandar/devflow/pull/1). PR #1 GitHub Actions passed,
as reported by the owner. M3.5 operational acceptance remains OPEN.**

## Current state — verification evidence reconciliation

- DevFlow runs locally on Fedora Linux 44, with Docker PostgreSQL development and
  isolated test databases. **Production deployment has not started.**
- Historical verification: 485 unit/UI tests across 50 files, 124 PostgreSQL tests
  across 11 files, and owner-run Playwright 12/12 in 3.1 minutes on desktop/mobile
  Chromium. The owner reports improved readability at normal browser zoom.
- PR #1 hosted CI succeeded; no CI run ID/URL, tested SHA, additional test totals or
  verification date is supplied here. The PR link is not a CI-run link.
- Current main and audit-branch base are d21dc1a. Historical runs and successful PR
  checks are **not proof of a separate full rerun on the squash commit**.
- Local backup/key restore, rollback and supervised worker/fault-recovery exercises,
  disposable GitHub automation acceptance and detailed accessibility/zoom evidence
  remain outstanding. Future production configuration/deployment gates are separate.

This reconciliation occurs on audit/m3-5-operational-acceptance. No worker, DB,
environment, connection, rule or task changes are authorized. Preserve DEV-002 and
its history; active exercises require separately approved disposable scope.

## Historical implementation ledger — originally recorded 2026-11-18

| Step | Delivered change                 | Commit / evidence                                                                                      | Remaining acceptance                                                     |
| ---- | -------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| 1    | Baseline and acceptance gates    | f1a1a2b; initial 326 unit cases; separate format-only f101e28                                          | Historical baseline, not current test totals                             |
| 2    | Durable scoped worker signals    | 8fbdc3e; covered by historical owner SQL suite                                                         | Real supervised interruption/restart evidence still open                 |
| 3    | Administrator health API         | fb5d5b0; covered by owner SQL suite                                                                    | Real browser role/scope acceptance still open                            |
| 4    | Health in existing GitHub panel  | e3f6ecf; owner observed Healthy idle and Unavailable                                                   | Browser automation/other evidence classifications remain open            |
| 5    | Explicit connection revalidation | 09a32aa; owner verified repository/admin access with no retargeting/automation change                  | Failure lifecycle is mocked/SQL-tested; no fresh live revocation claimed |
| 6    | Read-only retention impact       | 1373a87; owner accepted rendered counts/ages/preservation; included in historical SQL run              | Browser acceptance and deployment-specific performance evidence open     |
| 7    | Failure/recovery journeys        | df10219; owner recovery file 6/6; included in historical full SQL suite                                | Fixtures model interruption; no real process-kill recovery claimed       |
| 8    | Isolated CI verification         | ecee52a; owner full SQL **124/124, 11 files** and unit/HTTP/DOM **476, 49 files**; static/build passed | Later PR #1 hosted CI passed; separate squash-SHA rerun not established  |
| 9    | Deployment/acceptance runbooks   | Runbooks committed at b92712e, now included in main squash d21dc1a                                     | Local recovery/operational exercises and release acceptance remain open  |

Owner-reported Step 8 TypeScript, ESLint, formatting, Prisma validation/generation,
worker compilation and isolated webpack build passed. These are owner-local results,
not a new sandbox execution or hosted CI. Earlier 117/117 was a pre-Step-7 baseline;
Step 7 added six recovery-file cases **plus one revalidation-file cooldown case**.
That historical full 124/124 result resolved the earlier SQL suite uncertainty.
Later owner-reported Playwright 12/12 establishes aggregate desktop/mobile success,
not the complete detailed matrix or a d21dc1a rerun. Live Groq remains unverified.

### Implementation and safety review

- [x] All nine implementation/doc areas and typography are committed and merged in d21dc1a.
- [x] Same PostgreSQL queue, fencing and separate worker architecture; no Redis/new service.
- [x] Health distinguishes fresh continuous polling from bounded or insufficient evidence.
- [x] Admin-only scope guards; no secrets/raw payloads in operational summaries.
- [x] Revalidation is explicit, identity-preserving and uses the permitted caller's authorization.
- [x] Retention remains read-only, with dependency/preservation rules and incomplete results.
- [x] Historical SQL 124/124 and later unit/UI 485 results are recorded with their scope.
- [x] Step 9 runbooks are committed and incorporated in main squash d21dc1a.
- [ ] Record current local migration-state evidence for operational exercises; before any
      future production rollout, separately verify its target and eight-migration state.
- [ ] Backup/key recovery rehearsal and artifact/schema-compatible rollback plan approved.
- [x] Owner reports successful PR #1 hosted CI and completed squash merge.
- [ ] Retain CI run URL/tested SHA/results; establish any required post-squash verification
      explicitly, without attributing historical test totals to d21dc1a.
- [x] Owner reports 12/12 desktop/mobile Chromium browser passes.
- [ ] Retain per-case reports/traces and current-release mapping for detailed acceptance.
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

[PR #1](https://github.com/jameelsikandar/devflow/pull/1) already passed hosted CI and was squash-merged
into main at d21dc1a, according to the owner. Do not repeat the old feature-branch
push/PR/merge procedure or describe that completed verification as pending.

The exact hosted run URL/tested SHA and per-stage counts remain evidence gaps.
Do not infer a post-merge run on d21dc1a from PR success. The workflow includes
schema/client/migrations, formatting/lint/types, worker compilation, mocked-provider
unit tests, real isolated SQL tests and webpack. It does not run Playwright or
start a live worker. Its CI PostgreSQL16 fixture differs from local Compose18.

For **future changes only**:

1. Obtain explicit approval before a push, PR creation or merge. Confirm branch,
   reviewed diff and repository destination. No force-push/history rewrite.
2. Inspect the **Isolated verification / Types, tests and production build** run
   for the actual tested SHA; retain its URL, stage results and actual test counts.
   Historical 485/124 totals are not substituted for the job's output.
3. Never add production/hosted database URLs or live OAuth/AI secrets to repair CI.
   Reproduce failures with mocks/devflow_test and make focused fix commits.
4. A push to audit/\*\* alone does not match the current push filters. The existing
   pull_request trigger can verify future approved work; no workflow change is
   made or new remote action authorized by this reconciliation.
5. Merge only after explicit review/approval. A successful CI run does not replace
   local recovery, disposable GitHub lifecycle or release-owner acceptance.

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
operational compatibility review. Production deployment has not started. Local restore/process-interruption and
detailed acceptance remain unverified; historical browser passes and PR #1 CI
success are recorded separately above. No such exercises ran during this update.

**Do not mark M3.5 complete until required outstanding acceptance is recorded and
reviewed. The completed implementation/merge and milestone operational acceptance are separate.**
