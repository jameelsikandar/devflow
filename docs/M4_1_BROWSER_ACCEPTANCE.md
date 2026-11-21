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

## Startup-path correction and fresh snapshot

The first owner-authorized attempt failed before Next started: Playwright resolved
`node_modules/next/dist/bin/next` relative to `e2e/`. The focused configuration now
sets `webServer.cwd: process.cwd()` explicitly. Run Playwright from the snapshot
root, the same directory checked by the environment guards. Next's `.next` stays
inside that new snapshot. No startup success is claimed by the static correction.

The failed `/tmp/devflow-m41-browser-1yrfe5h8`, its log and
`browser-acceptance.STARTED` marker are retained evidence. **Never modify or reuse
that directory.** This procedure creates a different directory from committed
baseline `038c134` plus the reviewed correction. No backup, integration evidence
or M3.5 resource is read, copied or altered.

After source review, prepare a new snapshot (no server/database operation):

```bash
set -euo pipefail
set +x
cd ~/codegrid/codex-projects/test-project
test "$(git branch --show-current)" = feature/m4-project-documents
test "$(git rev-parse --short=7 HEAD)" = 038c134
umask 077
m41_snapshot="$(mktemp -d /tmp/devflow-m41-browser-cwd-XXXXXXXX)"
git archive --format=tar 038c134 | tar -xf - -C "$m41_snapshot" --exclude='.env*'
# Explicit reviewed overlays only; never copy the working tree or old snapshot.
cp e2e/documents.config.ts "$m41_snapshot/e2e/documents.config.ts"
cp e2e/documents-startup.check.mjs "$m41_snapshot/e2e/documents-startup.check.mjs"
cp docs/M4_1_BROWSER_ACCEPTANCE.md "$m41_snapshot/docs/M4_1_BROWSER_ACCEPTANCE.md"
ln -s "$PWD/node_modules" "$m41_snapshot/node_modules"
git rev-parse HEAD > "$m41_snapshot/source-revision.txt"
(
  cd "$m41_snapshot"
  sha256sum e2e/documents.config.ts e2e/documents-startup.check.mjs \
    docs/M4_1_BROWSER_ACCEPTANCE.md > reviewed-overlays.sha256
  sha256sum -c reviewed-overlays.sha256
  test ! -e .next
  test ! -e browser-acceptance.STARTED
  node e2e/documents-startup.check.mjs
)
printf 'New snapshot: %s\n' "$m41_snapshot"
```

Stop if the branch/baseline changed; prepare a reviewed command update rather than
bypassing the checks. The unchanged spec is committed in `038c134`; the three
explicit overlays are candidate changes, not claimed to be in that commit.
`node_modules` reuses installed dependencies through a symlink. Do not install,
generate, migrate or rebuild dependencies from this snapshot. There is no copied
`.env*`, `.git`, `.next`, database, backup, report or private evidence.

The focused configuration intentionally avoids `dotenv/config`, refuses real root
`.env` files and checks generated Prisma metadata for environment-file paths
without importing Prisma. It fails closed if the reused client would discover an
unreviewed env path. If dependencies/client change, review and prepare again rather
than removing this guard. Execute in the snapshot with the clean environment below.

## Approval required before execution

No server or browser was started while preparing this correction. Owner approval
must explicitly cover starting the isolated Next server on `127.0.0.1:3101`, browser execution and
synthetic fixture writes to **localhost:5433/devflow_test/public only**.

Preconditions:

1. Review the three correction files and new snapshot overlay hashes. If files
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
cd "$m41_snapshot"
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
: "${m41_snapshot:?Use the newly prepared and reviewed snapshot path}"
cd "$m41_snapshot"
sha256sum -c reviewed-overlays.sha256
node e2e/documents-startup.check.mjs
test ! -e .env
test ! -e .env.local
test ! -e .env.development
test ! -e .env.development.local
test ! -e browser-acceptance.STARTED
read -rsp 'Approved devflow_test URL (hidden): ' m41_test_url
printf '\n'
test -n "$m41_test_url"
m41_status=0
# URL travels through stdin, never command arguments. A run is consumed even on failure.
printf '%s' "$m41_test_url" | env -i PATH=/usr/bin:/bin HOME=/home/jemi \
  NEXT_TELEMETRY_DISABLED=1 M41_BROWSER_ACCEPTANCE=devflow_test-only \
  /usr/bin/node -e '
    const fs = require("node:fs");
    const cp = require("node:child_process");
    process.env.TEST_DATABASE_URL = fs.readFileSync(0, "utf8");
    const marker = fs.openSync("browser-acceptance.STARTED", "wx", 0o600);
    fs.writeSync(marker, JSON.stringify({ startedAt: new Date().toISOString() }) + "\n");
    fs.closeSync(marker);
    const log = fs.openSync("browser-acceptance.log", "wx", 0o600);
    const result = cp.spawnSync(process.execPath, [
      "node_modules/@playwright/test/cli.js", "test",
      "--config", "e2e/documents.config.ts"
    ], { env: process.env, stdio: ["ignore", log, log] });
    fs.closeSync(log);
    fs.writeFileSync("browser-acceptance.RESULT.json", JSON.stringify({
      exitCode: result.status, signal: result.signal,
      launchFailed: Boolean(result.error), finishedAt: new Date().toISOString()
    }) + "\n", { flag: "wx", mode: 0o600 });
    console.log("Browser attempt finished; inspect private evidence in this new snapshot.");
    if (result.error || result.signal || result.status !== 0) process.exit(1);
  ' || m41_status=$?
unset m41_test_url
test "$m41_status" -eq 0
```

`HOME` is passed to the child only to find the owner's already-installed browser
cache. The procedure does not copy home files. OS-level environment/process access
is not a secrets vault; run only under the trusted local account. Do not inspect or
share process environments. If the terminal is interrupted before `unset`, clear
`m41_test_url` manually.
The exclusive `wx` marker prevents a second attempt in the same directory. On any
failure retain the marker, private log and result; never remove them to retry.
Any later retry needs a new reviewed snapshot and owner approval.

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

## Historical preparation checks

Executed for the original preparation, not a new browser result:

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

## Startup correction verification

The correction is limited to explicit startup cwd, a source-AST regression check
and these revised instructions. The check requires an explicit root cwd, the
unchanged Next CLI command/port, no server reuse and a readable installed CLI file.
It reads source/metadata only and does not import the application or start Next.
Formatting, lint, TypeScript and fresh-snapshot discovery are reported separately
with the correction. Only an authorized real run can establish successful startup,
focus behavior, persistence and browser acceptance. The failed attempt is not a
passing browser test and does not consume or replace earlier database evidence.

## Permission-picker timeout diagnosis (baseline `9b0b40e`)

The later owner-authorized attempt in
`/tmp/devflow-m41-browser-cwd-l05j4i_r` started Next successfully but both journeys
failed at the 120-second test limit. Keep that entire snapshot, markers, logs,
reports and synthetic records unchanged; it is now failure evidence, not a reusable
execution directory. The earlier `1yrfe5h8` startup failure remains retained too.
The preparation/execution examples above describe earlier baselines; do not reuse
those snapshots or commands for this candidate. A later approved run needs a fresh
snapshot from the reviewed source/candidate changes and a new one-use marker.

Read-only inspection decoded the embedded HTML report ZIP in memory. Both action
trees identify **original `e2e/documents.spec.ts:180:66`**, selecting the workspace
member with `getByLabel('Workspace member', { exact: true })`:

- Chromium: the select action waited **85,823 ms** before the overall test timeout.
- Mobile Chromium: the same action waited **99,236 ms**.

Both error contexts expose a `combobox` named `Workspace member`, with Robin Reader
available but the placeholder still selected, and Save access disabled. Invitation
and membership checks had completed before this action. Playwright 1.56.1's
`getElementLabels` uses `elementText` on the wrapping `<label>`, including nested
option text. Exact label-text matching therefore misses this control even though
its accessible combobox name is correct. No permission submission was reached at
the stalled action; evidence does not indicate a slow grant API or overlay defect.

The candidate uses exact **combobox role/name** locators for Workspace member,
Permission and Document state. A shared named grant step verifies the option's
user ID, selected member/permission, enabled save button, real grant PUT status 200
and resulting grant label. Named authentication, navigation, invitation, Reader,
Editor, revocation, isolation and archive steps preserve the existing assertions
and make subsequent stalls identifiable. The 120-second limit, zero retries,
database guards and production application are unchanged.

The report also records a ZIP central-directory error, but retains no readable raw
trace ZIP/action file or stack explaining it. The embedded HTML report ZIP itself
is readable. The established failure is the locator timeout; the ZIP error appears
to be secondary artifact/teardown trouble, and its precise cause is **unconfirmed**.
No trace settings were weakened or evidence repaired/deleted. A new authorized
browser execution remains necessary to verify the correction and later stages.
