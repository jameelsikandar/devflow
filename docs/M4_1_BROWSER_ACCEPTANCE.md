# M4.1 focused browser acceptance preparation

## Scope and evidence

Application baseline: `b50c73f7d17ee27155639e12478a1e489190d537`, branch
`feature/m4-project-documents`. No application implementation changes are included.
See [project documents](../PROJECT_DOCUMENTS.md) for the permission model and
[verification](../VERIFICATION.md) for historical checks.

Owner-reported Fedora evidence preceding this preparation:

- 522 unit/HTTP/UI tests passed.
- 11/11 document PostgreSQL integration tests passed.
- Nine completed migrations on `devflow_test`; unrelated baseline counts unchanged.
- Verified backup retained at `/home/jemi/devflow_test_m41_JBDNLg`.
- Integration evidence retained at `/home/jemi/devflow_m41_integration_CI70Du`.

Those paths were not accessed or modified during browser preparation. Historical
implementation notes in other documents are not new browser verification.

## Coverage prepared, not executed

[e2e/documents.spec.ts](../e2e/documents.spec.ts) contains one lifecycle journey,
run twice: desktop Chromium at 1440 × 900 and mobile Chromium using iPhone 13
emulation (390 × 664 viewport). This is Chromium emulation, not Safari or a real
phone. It covers:

- UI registration, project creation, empty document list, keyboard document creation.
- Title/summary persistence after refresh; rename through the existing dialog.
- Real invitation acceptance using local authenticated APIs; ordinary membership.
- Private-document omission and 404 denial before a grant.
- Reader UI without editing/access controls and denied PATCH; editor grant,
  successful metadata save and version increment; no archive permission; revocation.
- Foreign-workspace detail/list denial, including mixed project/workspace identity.
- Archive confirmation focus confinement, cancel without archival, then confirmation.
- Archived details retained/read-only, rejected PATCH, archive filter and refresh.
- Keyboard Enter, Escape and forward/reverse Tab confinement in form/confirmation
  dialogs; create-title autofocus. This is not a complete accessibility audit.
- Dark detail and light list screenshots; page-width overflow assertions in both.
  Screenshots still require human review; this does not test every responsive width,
  zoom level, contrast ratio, screen reader, or focus-return interaction.

The spec does not import Prisma, create privileged database fixtures or mock
permission responses. Workspace selection for the invited member uses the current
browser-local Zustand preference contract; grants and authorization still use real
server APIs. Permission setup is API-assisted rather than testing invitation UI.
The original general Playwright configuration is unchanged. The journey skips in
ordinary runs without the explicit acceptance marker, and checks the focused
configuration before fixture creation.

## Isolated source snapshot

Prepared directory: `/tmp/devflow-m41-browser-1yrfe5h8`.

- Application source comes from `git archive b50c73f`; all `.env*` files were excluded,
  including the safe example. No `.git`, `.next`, database, report, backup or rehearsal
  evidence was copied.
- Two reviewed candidate files are overlaid: `e2e/documents.spec.ts` and
  `e2e/documents.config.ts`. These are uncommitted changes, not claimed to exist in
  the baseline commit. `m41-snapshot.json` records the full revision and SHA-256s.
- `node_modules` is a symlink to the existing installed dependencies. No install,
  generation or rebuild of dependencies is permitted by this procedure. Do not run
  pnpm install, Prisma generation, migrations, or a worker from the snapshot.
- Next runs from this directory and creates its own `.next`. Existing development
  server output remains separate. The prepared snapshot is temporary, not a release.

The focused configuration intentionally avoids `dotenv/config`, refuses real root
`.env` files and checks generated Prisma metadata for environment-file paths
without importing Prisma. It fails closed if the reused client would discover an
unreviewed env path. If dependencies/client change, review and prepare again rather
than removing this guard. Execute in the snapshot with the clean environment below.

## Approval required before execution

No server or browser was started during preparation. Owner approval must explicitly
cover starting the isolated Next server on `127.0.0.1:3101`, browser execution and
synthetic fixture writes to **localhost:5433/devflow_test/public only**.

Preconditions:

1. Review all three candidate files and the snapshot overlay hashes. If files have
   changed, recreate/review the snapshot before execution; do not silently mix states.
2. Confirm the previously verified nine migrations and test database are still the
   intended target. This procedure does not migrate or prepare a database.
3. Port 3101 must be free. Do not stop an existing process to make it free.
   `reuseExistingServer: false` makes an existing listener a hard failure.
4. Existing Playwright Chromium binaries must be installed. If missing, stop and
   obtain separate approval for downloads; there is no automatic installation.
5. No concurrent tests, migrations, worker or other writer may use `devflow_test`.
   Keep development on its own database. Do not alter existing application processes.
6. Preserve the backup, integration evidence and all M3.5 resources. No cleanup is
   included in this procedure.

### Safe discovery only — no server, browser or database connection

```bash
cd /tmp/devflow-m41-browser-1yrfe5h8
env -i PATH=/usr/bin:/bin HOME=/tmp NEXT_TELEMETRY_DISABLED=1 \
  M41_BROWSER_ACCEPTANCE=devflow_test-only \
  /usr/bin/node node_modules/@playwright/test/cli.js test \
  --config e2e/documents.config.ts --list
```

Expected discovery: **two cases**, one per browser project. Discovery success does
not establish that either case passed. The discovery-only synthetic URL is never
used to connect and is unavailable as a fallback for actual execution.

### Guarded execution — NOT AUTHORIZED YET

After separate owner approval, run in a Fedora Bash terminal. Supply the existing
approved test URL silently; do not paste it into a command, report, or shell history.
This does not read or copy `.env`. The parent shell variable is not exported; the
child receives only the explicit environment below. Do not enable shell tracing.

```bash
set -euo pipefail
set +x
cd /tmp/devflow-m41-browser-1yrfe5h8
test ! -e .env
test ! -e .env.local
test ! -e .env.development
test ! -e .env.development.local
read -rsp 'Approved devflow_test URL (hidden): ' m41_test_url
printf '\n'
test -n "$m41_test_url"
# Keep the URL out of OS command arguments: populate a child environment through stdin.
printf '%s' "$m41_test_url" | env -i PATH=/usr/bin:/bin HOME=/home/jemi \
  NEXT_TELEMETRY_DISABLED=1 M41_BROWSER_ACCEPTANCE=devflow_test-only \
  /usr/bin/node -e '
    const fs = require("node:fs");
    const cp = require("node:child_process");
    process.env.TEST_DATABASE_URL = fs.readFileSync(0, "utf8");
    const result = cp.spawnSync(process.execPath, [
      "node_modules/@playwright/test/cli.js", "test",
      "--config", "e2e/documents.config.ts"
    ], { env: process.env, stdio: "inherit" });
    if (result.error || result.signal || result.status !== 0) process.exit(1);
  '
unset m41_test_url
```

`HOME` is passed to the child only to find the owner's already-installed browser
cache. The procedure does not copy home files. OS-level environment/process access
is not a secrets vault; run only under the trusted local account. Do not inspect or
share process environments. On a failed run, clear `m41_test_url` manually if Bash
exits before the final `unset`.

The configuration checks PostgreSQL protocol, local hostname, exact port 5433,
exact decoded database name `devflow_test`, public schema and no other URL options
**before the server can start**. The server receives this URL as `DATABASE_URL` and
uses the dedicated snapshot `.next`. The app URL is fixed to port 3101.

AI/GitHub credentials, webhook secret and encryption key are blank; AI endpoint is
unreachable loopback, GitHub demo mode false, and no worker is started. The test
only invokes local registration, project, invitation and document APIs. Nonlocal
browser HTTP requests are blocked and fail the assertion. This is not an OS egress
firewall or a claim that all server-side network traffic is intercepted. Do not
navigate to integrations or providers during the run.

## Persistent synthetic records and cleanup limits

A complete two-project browser run creates six unique synthetic users, six personal
workspaces and one acceptance project/document per browser project (two projects,
two retained archived documents total). Email addresses use UUIDs at `example.com`.
Each member joins only its synthetic owner's workspace. Invitations are consumed,
reader/editor grants are revoked before archival, and permission attempts target
only that run's document IDs. No tasks or GitHub rules/connections are created.

Sessions, workspace labels, activity/notifications, heartbeat/presence and database
rate-limit records may also be written by normal application behavior. The global
authentication limiter is shared test infrastructure. Counts therefore will not
remain at the pre-browser baseline. Failures can leave partial fixtures, including
a grant or an unused invitation. No automatic record deletion is implemented;
closing browser contexts is not database cleanup. Do not rerun indiscriminately
or delete by email/name wildcard. Cleanup needs a separately reviewed, exact-ID,
dependency-aware plan and owner approval. Never reset `devflow_test`.

## Evidence and stop conditions

Expect two passing journeys only after actual execution. Keep stdout/stderr and
exit status, screenshots, HTML report (`playwright-report/documents`) and failure
traces (`test-results/documents`) in the snapshot. Reports/traces can contain
synthetic passwords, session cookies, invitation tokens and local URLs: keep them
private and outside Git. Do not publish raw traces. Human-review the screenshots
at both viewport sizes before accepting visual quality.

Stop on guard failure, occupied port, missing browser/client, unreviewed snapshot,
wrong migration/target, failed registration, permission mismatch, unexpected external
request, missing record, overflow or failed assertion. No timeout increases,
automatic retry, alternate target/server reuse, migration repair or broad cleanup.
Playwright owns only the server it launches; do not signal arbitrary processes.
Failures are evidence to investigate, not acceptance. No production readiness,
real-provider acceptance or full accessibility claim follows from these tests.

## Preparation checks

Executed during preparation:

- Full TypeScript (`--noEmit --incremental false`) and core TypeScript passed.
- Focused ESLint and three-file Prettier checks passed.
- Three local Markdown links and `git diff --check` passed.
- Snapshot verification: 286 committed files matched HEAD, and two candidate
  overlays matched their recorded SHA-256s; no `.env*` or `.next` was present.
- Isolated `--list` discovery succeeded: two cases, **not executed**. An initial
  config-loader incompatibility was corrected before successful rediscovery.
- Negative discovery checks rejected application-database, remote-host, URL-option
  override and malformed-URL inputs without printing the supplied URL.

No unit/integration suite, build, server, browser, migration, provider call or
database-writing operation was executed during preparation. Browser behavior,
visual quality and persistence remain unverified by this new suite.
