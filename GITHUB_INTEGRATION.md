# GitHub integration — M3.1–M3.4 implementation and M3.5 readiness

M3.1 adds secure repository connections and a durable webhook inbox. M3.2 adds a
separate durable worker, read-only GitHub activity and task associations. Neither
phase runs task-changing workflows. M3.3 adds definitions and read-only previews;
see the latest M3.3 section for setup and safety semantics.
M3.4 now adds explicitly confirmed future-event status automation. Its latest
section below supersedes earlier preview-only deployment notes. Existing OAuth,
repository browsing, commit history and open-PR reads are retained.

## Current operational status — M3.5 step 1

M3.1–M3.4 source is implemented. M3.5 is approved for operational acceptance and
hardening; this first change establishes baseline evidence and reconciles docs only.
Existing processing controls, task links, previews and confirmed PR automation retain
their current behavior. No new health monitor, diagnostic operation, retention logic
or CI job is implemented in this step. The acceptance ledger below is current;
earlier phase sections remain historical implementation/setup records.

## Architecture decision

Reuse the existing GitHub OAuth app (`repo read:user`) and AES-256-GCM encrypted
per-user token. Connection creation performs a fresh `GET /repos/{owner}/{repo}`
with that token and requires `permissions.admin === true`, an active repository,
and an authorized DevFlow workspace owner/admin. Merely seeing a repository or
having push access is insufficient. A canonical numeric GitHub repository ID,
not its changeable name, is the webhook authorization boundary.

OAuth does **not** register a webhook, and no additional hook-management scope is requested. The existing broad `repo`
scope is unchanged; its presence is not used as proof of webhook permission.
A repository admin manually creates the webhook in GitHub, using a separate random
256-bit secret generated for that DevFlow connection. Secrets are encrypted with
the existing server encryption key, shown once to the authorized administrator,
and excluded from connection-list, delivery-list, snapshot and activity responses.
The setup response is `Cache-Control: no-store`; the UI keeps the secret in dialog
state only and clears it when closed. A lost setup secret requires disconnecting
and creating a replacement connection. No global webhook secret is shared across
workspaces/repositories. No extra runtime dependency is installed.

A GitHub App is preferable for future fine-grained installation permissions,
short-lived installation tokens and installation/repository revocation events.
It is deferred because introducing it now would duplicate working OAuth without
also implementing the installation lifecycle safely. This manual foundation is a
supported OAuth + repository-hook flow, not an installation-flow simulation.

References: [GitHub webhook permissions](https://docs.github.com/en/webhooks/using-webhooks/creating-webhooks?apiVersion=2022-11-28),
[OAuth scopes](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps),
[signature validation and test vector](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries),
[delivery best practices](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks).

## Local / deployed setup

1. Apply the additive migration through your normal release process, without any
   reset or seed: `pnpm db:migrate`, then `pnpm db:generate`. For test-only migration
   preparation, use `pnpm db:prepare:test`; its isolation guard requires a separate
   database ending in `_test`.
2. Configure `.env` with `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`,
   `TOKEN_ENCRYPTION_KEY` (64 hex characters) and `APP_URL`. Generate a new encryption
   key with `openssl rand -hex 32` only for a new installation; do not replace an
   existing key without re-encrypting stored OAuth tokens/webhook secrets.
3. For actual GitHub delivery, `APP_URL` must be the publicly reachable HTTPS origin.
   Use an HTTPS tunnel for local testing. Register the matching OAuth callback
   `<APP_URL>/api/github/callback` in GitHub. Localhost HTTP is accepted for local
   fixture setup only; GitHub cannot deliver to your localhost address directly.
4. Log into DevFlow as workspace owner/admin, open GitHub, authorize your GitHub
   account, select the target project in the existing picker, and click **Connect
   project** on a repository where you are an administrator. Existing legacy string
   links alone do not authorize webhooks. The existing repository picker lists up
   to 100 repositories; the connection API also accepts an explicit repository name.
5. In that GitHub repository, open **Settings → Webhooks → Add webhook**. Copy the
   setup dialog's Payload URL and one-time secret, choose `application/json`, keep
   SSL verification enabled, and select Pushes, Pull requests, Issues and Workflow
   runs. Activate the webhook. GitHub's initial `ping` is also supported. Event names
   in the dialog are API names (`push`, `pull_request`, `issues`, `workflow_run`).
6. GitHub Recent Deliveries should show 202 for a new accepted event and 200 for an
   already accepted exact replay. The administrator delivery-list API below shows
   the newest 50 receipt states. `PENDING` is expected until the M3.2 worker is running.
7. To disconnect, use **Disconnect repository webhook**. Also remove/disable the
   remote webhook in GitHub; M3.1 does not call hook-management APIs.
   Old endpoint requests now return 404. Reconnect creates a new URL and secret.

Account OAuth disconnect removes only the personal OAuth token. Repository webhook
connections are independent delegated workspace connections and must be explicitly
disconnected by a workspace admin. They do not require the creator's token for each
incoming event. Repository transfers, installation revocation and ongoing permission
reconciliation are not implemented; disconnect manually when repository access
should be revoked. Disconnection remains available for archived projects.

## Endpoints

All management APIs require the existing session, active workspace membership and
normal Origin validation for writes. `workspaceId` is always the active workspace
query parameter, not a body override.

| Endpoint                                                    | Permission and behavior                                                                                                                    |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/github/repositories?workspaceId=…&projectId=…`    | Workspace member; active connection metadata only                                                                                          |
| `POST /api/github/repositories?workspaceId=…`               | Workspace owner/admin + fresh GitHub repo admin; strict `{projectId, repository: "owner/repo"}`; returns 201 connection and one-time setup |
| `DELETE /api/github/repositories/:id?workspaceId=…`         | Workspace owner/admin; idempotent soft disconnect, secret erasure and cancellation of unfinished inbox work                                |
| `GET /api/github/repositories/:id/deliveries?workspaceId=…` | Workspace owner/admin; latest 50 receipt metadata records, including disconnected history                                                  |
| `POST /api/github/webhooks/:connectionId`                   | No browser session/Origin requirement; exact-body HMAC, active connection, matching repository ID and event validation required            |

Legacy `Project.repository` remains for compatibility with existing activity reads.
New secure connections update it transactionally. Direct project PATCH cannot
change that string while an active secure connection exists. Existing legacy links
can still be unlinked; they are never silently converted into authorized inboxes.

## Webhook security, privacy and durability

The receiver reads at most **1 MiB** of uncompressed JSON and verifies
`X-Hub-Signature-256` over the original bytes using Node HMAC SHA-256 and
`timingSafeEqual`. No SHA-1, unsigned fallback, proxy-reencoded body or OAuth-token
comparison is accepted. It then validates a UUID delivery ID, the event allowlist,
and repository numeric ID. Unsupported events return 422; malformed data 400;
invalid signatures 401; wrong repository 403; oversized body 413. Disabled or
unknown connections return 404, unavailable/archived projects 409. Database errors
produce non-2xx responses, so an event is never acknowledged before durable commit.
GitHub's delivery/redelivery controls must be used after outages; DevFlow does not
claim that GitHub automatically retries every failure.

The READ COMMITTED transaction locks the project then connection, rechecks availability, checks
receipts and inserts a PENDING record. The same lock order is used for disconnect.
Unique `(connectionId, deliveryId)` records prevent duplicate work; reuse of a
UUID with changed bytes or event type returns 409. A second unique
`(connectionId, payloadHash)` guard collapses exact-body replays even when the
unsigned delivery-ID header changes. Such aliases reuse the original canonical
receipt, rather than retaining extra rows. A payload replay with a different event
header returns 409 after its canonical receipt exists. GitHub supplies no signed
nonce/timestamp here; there is no invented request-age check or claim that headers
are covered by HMAC. HTTPS and per-connection secret handling remain essential.

Persisted event data is an explicit allowlist:

- Ping: repository ID only. Hook configuration/secrets and sender profiles discarded.
- Push: ref, before/after SHA, deleted flag, commit SHAs and extracted DEV references.
  At most 100 of the supplied commits are retained, with commit count and explicit
  truncation marker. Raw commit messages, emails and author records are discarded.
- PR/issue: number, action, state, DEV references; PR merge flag and SHA where present.
  No titles, bodies, diffs, profile data or arbitrary URLs are retained.
- Workflow run: run ID, action, head SHA, status and conclusion.

Only a payload hash is kept for replay comparison; raw request JSON is not stored.
DEV references are untrusted text observations, not task ownership or associations.
No task is resolved or updated in M3.1. Stored private-repository facts remain
workspace-scoped. Keep inbox data backed up with the application database.

One active connection per project is enforced by a SQL partial unique index, while
historical connections/receipts remain available. Disconnect atomically disables
the connection, erases its encrypted secret, cancels unfinished receipts and records
a workspace activity entry. Deleting the owning project intentionally cascades its
connection/receipts, like other project data; soft disconnect never deletes them.

`PENDING/PROCESSING/PROCESSED/FAILED/CANCELLED`, attempt count, availability/lease
and completion/error fields establish the future queue contract only. There is no
worker, automatic retry, event-to-task transition or workflow action yet. M3.2 must
reconcile latest GitHub state, handle truncation/out-of-order events, fence leases
and recheck connection/project availability before any side effect. Repository
permission lifecycle reconciliation and retention/monitoring are later gates.

## Verification

Unit tests cover exact-byte and published-vector signatures, malformed signatures,
input validation, minimization/truncation, admin permissions, scope filters, replay,
write failure and locked-state rechecks. A DOM fixture covers project connection,
one-time setup dialog and explicit disconnect. Real-DB tests use only the guarded
`devflow_test` database, real connections/constraints/transactions and an injected
GitHub HTTP fixture (no live GitHub or Groq calls). They cover concurrent duplicates,
connection races, cross-workspace constraints, forged deliveries, persistence,
disconnect/reconnect and archived projects. See `VERIFICATION.md` for actual results;
fixtures and discovered cases are not live-provider or database acceptance.

## M3.2 processing architecture

PostgreSQL remains the only queue. The separate Node worker claims eligible rows
using one short `FOR UPDATE OF d SKIP LOCKED` CTE/update, assigns a random ownership
token, increments attempts and sets a lease expiry using database time. Claims never
wait for project/connection locks. Expired leases are recovered in bounded batches;
legacy PROCESSING rows without leases are also recoverable. Lowering the retry limit
terminalizes previously scheduled records that already exhausted the new limit.

Processing and all GitHub requests run outside the publication transaction. The
worker renews a still-owned lease periodically. Completion locks project → connection
→ delivery, verifies active scope/token/expiry, bulk-writes objects, observations and
associations, then marks PROCESSED. Expiry is checked again at final acknowledgment;
a failure rolls back every publication write. Disconnect clears leases and cancels
unfinished work. A stale worker cannot publish or reschedule another owner's job.

This is **at-least-once execution with idempotent database effects**, not exactly-once
execution. Object keys are project/repository/kind/SHA-or-number; reconnecting the same
repository does not duplicate objects or task links. Observations are immutable per
object/delivery, and evidence links retain which observation justified an association.
Task deletion cascades its links/evidence; the source observation remains. Project
or connection/delivery deletion follows the documented foreign-key cascades; inbox
retention is an operational policy, not an automatic deletion job.

- Ping completes without objects, task activity or external HTTP.
- Push records retained commit facts. Duplicate SHAs share objects and associations;
  separate deliveries retain distinct observations/evidence.
- PRs/issues record number, state and actual DEV references. Missing references remain
  unresolved, including valid task numbers from other projects/workspaces.
- Workflow runs retain their stable run ID/head SHA/status. When present in a new
  webhook or an explicitly authorized API response, head-commit DEV references may
  create links. Legacy workflow records without references remain unlinked.
- DEV numbers are resolved only within the connection's project/workspace. No task
  status, assignment, priority, version, completion date or sprint membership changes.
- GitHub-generated activity is stored separately from human `TaskActivity`. Only
  explicit user actions such as retry/enrichment authorization create human audits.

Old M3.1 rows default to `dataVersion=1` without rewriting their JSON. New deliveries
use version 2 and preserve source update timestamps when actually supplied. Legacy
PR/issue/workflow observations without source time do not pretend to be current
projections. Mutable projections advance only for strictly newer source timestamps;
older/equal timestamps cannot overwrite newer state. Commit data is immutable by SHA.
Enrichment records preserve signed webhook facts separately from the minimal API
snapshot and its read time. Current projections contain source facts, not fabricated
ordering derived from receipt time.

## Optional enrichment authorization

Verified local facts work with **no enrichment grant and no GitHub API requests**.
A workspace owner/admin can explicitly click **Authorize enrichment with my GitHub
account**. The server checks that user's current GitHub repo-admin permissions and
numeric repository identity, then records the authorizer and authorization version.
It never silently borrows another user's token. Disable enrichment to revoke the
version; account deletion/reconnect or membership/role changes also invalidate a
worker's credential snapshot. The connection remains independent of personal OAuth
for signed webhook processing.

Authorized requests use fixed GitHub API paths constructed from validated repository
names, numeric IDs and SHAs; redirects and arbitrary payload URLs are refused. Repo
identity/name/permissions are checked before enrichment and rechecked after fetched
object data. Transfers/renames/credential failures fail closed for enrichment and
retain verified local facts. In-flight results are checked against current grant,
role and credential hash again before publication; invalidated results are discarded.
This is not a GitHub App installation/revocation subscription, and remote permissions
can change between API checks. Remove the remote hook/disconnect promptly when
repository delegation should end.

GitHub responses are bounded to 4 MiB and 15 seconds per request. Compare enrichment
uses at most three 100-commit pages and publishes at most 300 commit objects per
job, retaining explicit incompleteness. It does not reconstruct omitted data without
a grant. SHA-zero/deleted-branch comparisons and permanent/unavailable responses
retain local facts with a sanitized enrichment code. Known primary/secondary rate
limits honor Retry-After/reset timing and persist a hashed-credential cooldown shared
by workers. Transport does not retry internally. Transient failures schedule the
whole job; if retries exhaust, the receipt remains a dead letter for admin review.
Metadata, body, tokens and private error text are not logged.

## Worker build and operation

Node >=22.12 is required. No new dependency, Redis or BullMQ is used. Compile the
standalone CommonJS worker during the build, so production execution does not require
the `tsx` or `dotenv` development packages:

```bash
pnpm db:generate
pnpm github:worker:build
# Uses .env if present; inherited service environment takes precedence.
pnpm github:worker --once
pnpm github:worker
# Source-based development alternative:
pnpm github:worker:dev --once
```

`.worker/` output is ignored by Git, lint, formatting and main application typecheck.
Include it in the deployed build artifact together with production dependencies and
the generated Prisma client. The Next.js process does not start or schedule workers.
`deploy/devflow-github-worker.service` is a Fedora/systemd example only; adjust paths,
account, Node location and environment file before explicitly installing it. Never
put credentials in the service file or commit them. No service was installed here.

| Environment variable          | Default / limits                                               |
| ----------------------------- | -------------------------------------------------------------- |
| `GITHUB_WORKER_CONCURRENCY`   | 2; range 1–8                                                   |
| `GITHUB_WORKER_LEASE_SECONDS` | 120; range 30–900; heartbeat every lease/3                     |
| `GITHUB_WORKER_MAX_ATTEMPTS`  | 8; range 1–20                                                  |
| `GITHUB_WORKER_POLL_MS`       | 2000; range 250–60000                                          |
| `GITHUB_WORKER_ONCE_LIMIT`    | 25; range 1–1000                                               |
| `GITHUB_WORKER_CONNECTION_ID` | Unset = all eligible connections; optional exact connection ID |

Once mode bounds the number of attempted jobs and stops when no eligible work is
immediately available; it does not wait for future retries. A normal drain exits
successfully even if some attempted jobs were scheduled for retry/dead-lettered;
inspect status/logs. Startup/database failures exit nonzero. SIGINT/SIGTERM stops new
claims, drains bounded in-flight work and disconnects Prisma. Supervision restarts a
failed worker; expired leases recover abandoned jobs. Keep service stop timeout above
request/publication duration. Each worker opens a Prisma pool: size concurrency and
connection pools for your PostgreSQL capacity.

Retry backoff uses jitter, starting with a 1–2 second window and capped locally at
10 minutes. Provider-required cooldowns can exceed that cap. Permanent malformed/
unsupported events go directly to FAILED/dead-letter; transient errors retry up to
the configured attempt limit. FAILED with `deadLetteredAt=null` is scheduled;
FAILED with a timestamp is terminal. A workspace admin may explicitly retry a failed
record, resetting its attempt budget and invalidating old lease ownership. There is
no automatic retry of processed or cancelled records.

## Monitoring and administrative endpoints

The existing GitHub page adds a compact processing panel with state filters/counts,
lease/retry information, dead-letter/error codes, paginated objects and explicit
retry/enrichment controls. It polls read-only endpoints; browser activity never runs
the worker. Task buttons use authorized associations and the existing detail dialog.
Queue metadata is administrator-only. Members can view authorized project activity.
Objects are listed by creation time, with the latest three source observations;
this is not a promise of a complete chronological timeline.

| Endpoint                                                                          | Authorization / result                                                                                   |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `GET /api/github/repositories/:id/processing?workspaceId=…&state=FAILED&offset=0` | Owner/admin; counts plus 25 delivery metadata records; no lease tokens or payload secrets                |
| `POST /api/github/repositories/:id/deliveries/:deliveryRowId/retry?workspaceId=…` | Owner/admin, exact-origin write, strict `{}` body; FAILED only                                           |
| `POST /api/github/repositories/:id/enrichment?workspaceId=…`                      | Owner/admin, exact-origin write, strict `{enabled: true/false}`; enable uses caller's own GitHub account |
| `GET /api/github/projects/:projectId/activity?workspaceId=…&offset=0`             | Workspace/project membership; 25 objects, authorized task links, observation provenance/incompleteness   |

## Safely processing the existing pending ping/push

First complete the isolated database verification commands in VERIFICATION.md. No
reset/seed is required. After reviewing those results and backing up the application
DB, manually apply the additive migration using the normal configured application
URL (this command is `prisma migrate deploy`, not a reset):

```bash
pnpm db:migrate
pnpm db:generate
pnpm github:worker:build
# Obtain the connection ID from Prisma Studio or the authorized connection-list API.
# Select the active record for jameelsikandar/25-react-projects and the intended project.
GITHUB_WORKER_CONNECTION_ID=your_connection_id pnpm github:worker --once
```

Your existing PENDING ping/push are version-1-compatible and need no redelivery.
Ping becomes PROCESSED with no task activity. Push creates commit facts and links
only DEV references that were actually retained and match tasks in that project;
no matching references means no invented task links. Enrichment defaults off. Inspect
the processing panel or Prisma Studio for PROCESSED, attempts, timestamps and any
sanitized failure code. Once verified, run the supervised continuous worker. Do not
run two independent service managers accidentally; multiple intentional workers are
supported through leases/row locks but share database and provider capacity.

Production acceptance still requires real PostgreSQL concurrency/migration execution,
actual worker processing, live authorized GitHub enrichment/rate behavior and desktop/
mobile visual checks. Fixtures alone do not prove those gates. Retention cleanup,
long-term metrics/alerts, automatic repo/App lifecycle reconciliation and workflow
rules/task-changing actions are outside this M3.2 implementation.

## M3.2 padded task-reference repair

The reported `test: verify DevFlow task linking DEV-002` exposed a parser defect:
all GitHub reference extractors/validators expected a nonzero first digit immediately
after `DEV-`. They rejected `DEV-002` before the number-2 project lookup ever ran.
The normalizer deliberately discarded raw messages, keeping SHA and extracted refs;
commit object/observation builders also omit raw commit messages. Consequently an
old PROCESSED event with empty refs cannot be repaired merely by restarting/retrying
its old normalized JSON. Live JSON was not queried from this sandbox; the failure
is confirmed by source inspection and the exact-message regression, consistent with
the user's live counts.

A shared canonicalizer now accepts padding: `DEV-002`, `dev-0002` and `DEV-2` all
mean numeric task 2, with canonical reference `DEV-2`. It rejects zero and malformed
references, keeps query limits and project/workspace filters, and deduplicates aliases.
No task primary keys, numbers, display settings or existing records are renumbered.
Deploy/restart BOTH the Next.js application (webhook normalization) and the rebuilt
worker for future events; rebuilding the worker alone cannot restore messages already
omitted by an old receiver.

For the existing `9023d37…` commit, an explicit administrative endpoint repairs links:

`POST /api/github/repositories/:connectionId/commits/:shaOrUniquePrefix/reconcile?workspaceId=…`

Use a strict `{}` JSON body. The endpoint:

- Requires the current workspace/project administrator, an active connection/project,
  and that caller's own existing explicit enrichment grant/OAuth account.
- Resolves a SHA prefix only among existing COMMIT objects in that bound project and
  repository. Ambiguous prefixes fail; use the full SHA instead. It requires an
  existing PROCESSED source observation belonging to the selected connection.
- Verifies current GitHub repository identity/admin permissions, fetches the actual
  commit by its full stored SHA, requires matching response SHA and extracts refs
  from its real message. It rechecks repository and authorization before publication.
- Uses the same project → connection lock order, scoped task resolver and idempotent
  link/evidence writes. It never posts user-supplied refs/message as authoritative data.
- Leaves delivery state, object data and original observation JSON/count unchanged.
  Evidence anchors to the existing observation proving the commit was received.
  Newly recovered API-derived refs/source SHA are recorded separately in an explicit
  human-request audit; the original event is not falsified and the commit's author
  is not attributed to the requesting administrator.
- Repeating the repair adds no duplicate links/evidence/observations or extra audit
  if nothing new was linked. Missing/foreign task numbers remain unresolved.

No migration is needed for this fix. First run isolated verification and deploy:

```bash
# If needed, prepare the separate test DB without resets:
pnpm db:prepare:test
pnpm github:worker:build
pnpm typecheck
pnpm typecheck:core
pnpm lint
pnpm test
AI_API_KEY= pnpm test:integration
pnpm build:webpack
# Restart the web app and worker using your normal deployment/service commands.
```

Do NOT change PROCESSED to PENDING, delete receipts, edit old observation JSON or
bypass replay protection. GitHub redelivery of the identical webhook remains a
replay and will not rewrite old refs. No new commit is necessary.

Open DevFlow at its configured APP_URL as the workspace admin. In GitHub processing,
explicitly authorize enrichment **with your own GitHub account**. If this is a one-off
repair and you normally disable enrichment, pause the worker during the grant and
disable enrichment afterwards. Then run this same-origin request in the browser
console, substituting the actual workspace and active connection IDs from Prisma
Studio or the authorized connection API (no API key/session token is pasted):

```javascript
const workspaceId = 'YOUR_WORKSPACE_ID';
const connectionId = 'YOUR_ACTIVE_CONNECTION_ID';
const result = await fetch(
  `/api/github/repositories/${encodeURIComponent(connectionId)}/commits/9023d37/reconcile?workspaceId=${encodeURIComponent(workspaceId)}`,
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  },
);
console.log(result.status, await result.json());
```

Expected first success for the reported case: `references: ["DEV-2"]`, no unresolved
refs, one new link and one new evidence record. A repeat returns zero new link/evidence
counts. Your three PROCESSED deliveries, two objects and two observations stay as-is.
The expected counts are acceptance criteria, not a claim the live repair ran here.
If `DEV-2` is unresolved, verify Task.number 2 actually belongs to that connection's
project; the repair deliberately does not search other projects. A permission, SHA,
identity or availability error leaves records untouched. Refresh the GitHub page/
Prisma Studio to inspect links/evidence. Do not infer missing message text manually.

## Read-only GitHub activity in task details

Task details now show the existing M3.2 associations directly. No reprocessing,
reconciliation or migration is required to display an already-linked commit.

To see the verified DEV-002 / 9023d37 association after deploying the updated app:

1. Open **Board**, select the **DevFlow** project (or find its task in the workspace
   board), and locate **DEV–002**. A small GitHub/fork icon and association count
   appears in the card footer. Refresh the Board if it was already open; its normal
   workspace snapshot also refreshes every 30 seconds.
2. Click the card body/title or its passive GitHub indicator to open the existing
   task detail dialog. The separate drag grip still controls dragging.
3. Scroll below the task editor and Comments/Activity area to **GitHub activity**.
   The section spans the dialog width and should show **Commit 9023d37** with
   **jameelsikandar/25-react-projects**. Open its link to visit the full stored SHA on
   GitHub using your browser's own GitHub session.

Associated pull requests, issues and workflow runs appear in the same section with
numbers and recorded statuses. Data comes from the database, not an on-open GitHub
API request; no OAuth/enrichment grant is needed just to view authorized records.
Source-timestamp projections are labeled with their source update time; legacy
status observations are labeled Observed. These are recorded facts, not a claim of
live GitHub freshness. No raw commit subjects/bodies are invented or fetched.

The section handles loading, empty/error/retry states, manually refreshes on request
and polls every 15 seconds while mounted. Results are paginated by ten linked objects.
Disconnected repositories retain accessible historical records with an explicit
notice. Missing/invalid repository metadata suppresses the external link rather
than constructing a guessed URL. All external links are generated from validated
repository names, supported object kinds and SHA/numeric identifiers, use HTTPS
GitHub URLs, and include `target="_blank" rel="noopener noreferrer"`.

`GET /api/tasks/:taskId/github?workspaceId=…&offset=0` requires the existing session
and workspace membership. The service independently verifies the task's project /
workspace, scopes association/object/connection queries, and returns only presentation
fields. OAuth tokens, webhook secrets, raw observation JSON and private sender data
are not selected/returned. Connection labels refer to the repository connection,
not a viewer's personal OAuth login. Read responses use `Cache-Control: no-store`.

Card counts use the existing Task.githubLinks relation through batched Prisma count
includes; there is no per-card HTTP query. The passive icon introduces no nested
button or drag listeners. Task fields/version/sprint membership, comments, existing
save/delete controls and drag handlers are unchanged. This feature is read-only and
does not implement M3.3/M3.4. No new dependency or schema migration is needed.

DOM/service tests cover safe URLs/status labels, all four kinds, disconnected/error/
empty/loading states, task-dialog controls and card click behavior. Database cases
cover actual stored links/counts, scope isolation, pagination and unchanged task
records. The desktop/mobile browser fixture uses explicitly intercepted GitHub
activity/count responses; it checks layout/links, screenshots in both themes and
keyboard drag cancellation, not live GitHub acceptance. See VERIFICATION.md for
which checks actually ran and the local commands.

## M3.3 — configure GitHub workflow rules and preview safely

M3.3 stores definitions only. There is no connection to the worker, automatic
execution, task service or M3.4. Enabling a rule is configuration, not permission
to execute an action. All task fields and existing evidence remain unchanged.
No new credentials, environment variables, webhook events or OAuth grants are
required. Apply the additive migration manually after isolated local verification
(VERIFICATION.md). Restart Next.js to load the new client/schema.

### Create “PR merged → Done” without changing DEV-002

1. Sign in as a DevFlow workspace owner/administrator. Open **Projects** and choose
   **Workflow rules** on the **DevFlow** project card.
2. Name the rule `PR merged → Done`. Choose the active repository connection
   `jameelsikandar/25-react-projects`, trigger **Pull request merged**, target **Done**
   and priority `100`. Leave **Enabled** unchecked; choose **Create disabled rule**.
3. Under **Dry-run preview**, select a real stored pull-request observation. For a
   matching result it must represent `closed` with `merged: true`, contain a DEV-002
   reference and have observation-specific task-link evidence from M3.2. It must
   also meet the freshness/completeness checks below.
4. Check **Include disabled rules in hypothetical preview**, then **Preview only**.
   A valid result shows DEV-002's actual current status → Done, task/rule versions
   and **hypothetical**. It creates no proposal, execution job, task activity or
   task update. Repeating it is safe and does not duplicate records.
5. Inspect **View configuration history** for rule revisions. Preview itself does
   not create a configuration revision. Edit/toggle/delete require explicit clicks;
   deleting a rule soft-deletes it and preserves its audit history.

The already-linked **commit 9023d37 is not a merged PR observation**. If only commit
observations exist, the preview shows an empty state. Do not invent a PR event or
rewrite historical observations to produce a match. Select an existing real PR
event, or manually open/merge a PR referencing DEV-002 and let the unchanged M3.2
worker process its verified webhook. Even an enabled rule will not change DEV-002.
Missing task evidence is explained rather than inferred from another observation.

### Evaluation semantics

- Triggers: opened (open/unmerged), ready_for_review (open/unmerged), closed+merged,
  closed+unmerged. Commits/issues/workflows and API `reconciled` actions never trigger
  a PR rule. Enriched observations are unwrapped to their original `webhook` facts.
- Optional connection scope matches one connection ID; null scope means all
  repository connections in this project only. A reconnect gets a new ID; old
  connection-specific rules must be edited explicitly. Disconnected events block.
- Disabled rules are excluded unless explicitly included in a hypothetical run.
  Smaller priority numbers win. Top-priority ties proposing different statuses
  block; identical targets are equivalent; lower-priority disagreements are shown
  as overridden. Results include all rule-match reasons, not just the winner.
- Only one unambiguous canonical DEV task reference/evidence target is eligible.
  DEV-002 and DEV-2 are aliases. Missing, foreign, deleted, unresolved or multiple
  referenced tasks do not produce a guessed transition. Existing task status and
  version are read at preview time; already-at-target results are labeled no-op.
- Reliable v2 source time must match the current object source timestamp. Events
  over seven days old, over five minutes in the future, or with conflicting current
  state/references are blocked. Legacy v1/missing timestamps fail closed. These
  checks deliberately prefer no transition when source facts are uncertain.
- Replayed deliveries retain existing M3.1/M3.2 uniqueness protections. An earlier
  observation with identical original webhook JSON on the same object causes a
  duplicate-event blocker. No preview writes or actions exist to replay.
- Lists return 25 observations/revisions per page with total/hasMore. The project
  supports up to 100 active definitions. All endpoints require current workspace
  owner/admin authorization, including reads and previews. API responses are no-store.

### API contracts

All paths below are under `/api`, require the session and `?workspaceId=...`.
Mutating HTTP methods additionally require the existing same-origin JSON checks.

- `GET projects/:projectId/github-workflows[&offset=0]`: active definitions,
  connection metadata and paginated PR observation choices (no secrets/payload dump).
- `POST projects/:projectId/github-workflows`: `{requestId: UUID, definition}`.
- `PATCH projects/:projectId/github-workflows/:ruleId`: same plus `expectedVersion`.
- `DELETE projects/:projectId/github-workflows/:ruleId`: `{requestId, expectedVersion}`.
- `GET projects/:projectId/github-workflows/history[&offset=0]`: audit snapshots.
- `POST projects/:projectId/github-workflows/preview`:
  `{observationId, includeDisabled?: false}`. Read-only despite POST; no execution API.

`definition` contains `name`, `connectionId` (ID or null), `trigger` (PR_OPENED,
PR_READY_FOR_REVIEW, PR_MERGED, PR_CLOSED_UNMERGED), `targetStatus` (existing Status
enum), `enabled` (default false), `priority` (0–10000, default 100). Unknown fields
are rejected. Changes increment version and append an audit revision atomically.
Request IDs are project-unique and bound to actor/operation/input hashes. Reusing
one with different input returns 409, as does a stale expected version. Configuration
writes use the established project-first lock; previews use repeatable-read snapshots
and are advisory rather than a reservation against future source/task/rule changes.

M3.4 execution remains out of scope. Any future executor will require fresh checks,
idempotency and separate authorization; the preview transition is not an executable
approval receipt. No automated action should be inferred from enabling these rules.

## M3.4 — confirmed future-event automation

M3.4 executes only the four supported PR rules. Commits, issues, workflow runs,
unverified data and AI output never authorize actions. Dry-run remains read-only.
No additional infrastructure or environment variable is required. Existing worker
options control concurrency, retries, poll interval, connection restriction and
bounded `--once` mode. Never put GitHub tokens or webhook secrets into worker logs.

### Lifecycle and database boundary

1. The signed webhook receiver preserves existing HMAC, identity and replay checks.
   New inserts carry `automationVersion=1`; all pre-upgrade rows retain default 0.
   Duplicate delivery/hash handling never changes an existing marker or receipt.
2. The unchanged durable delivery lease is claimed. Optional authorized enrichment
   occurs outside database transactions. In the fenced project→connection→delivery
   publication transaction, observations/evidence and an immutable evaluation record
   commit together. Eligible decisions become PENDING; blocked decisions are retained
   as SKIPPED/CONFLICTED. Ping and non-PR events produce no automation action.
3. The same worker prioritizes pending executions. It locks project→connection→
   delivery→execution→task. Live scope/source, project/archive, connection, enabled
   rule/version/activation, activating administrator role and task version/status
   are rechecked. The activating membership row is held FOR SHARE until commit.
4. Status CAS, execution APPLIED and one unique null-human-actor TaskActivity commit
   atomically. SQL failures/process death roll everything back. There is no external
   GitHub call in this action transaction and no long-running execution lease to
   abandon; database locks release on crash, leaving durable pending work.

A second stage keeps publication and action failures distinguishable and captures
an immutable expected task version between evaluation and action. A user edit in
that gap causes a conflict. Delivery PROCESSED means GitHub facts were published;
inspect **Automation executions** separately for task effects. The worker is
at-least-once with idempotent database effects, not a distributed exactly-once claim.

The new table stores workspace/project/repository/connection, original delivery,
observation, object, semantic event identity, selected rule/version snapshot, task
snapshot/version/statuses, full rule-match evaluation, outcome, sanitized reason,
attempt count/availability, start/completion timestamps and duplicate provenance.
Composite FKs/checks prevent foreign task/project targeting. Unique observation,
SHA-256 semantic claim and activity execution IDs prevent duplicate effects.
The event key includes project/repository/PR/action/source time/state/merged, excluding
rule edits, task-reference spelling and delivery UUID. Semantically repeated events
are recorded as duplicate skips, not another opportunity to run a new rule.

Task deletion nulls its execution target FK pair while retaining the immutable
snapshot. Rule deletion is soft and retains revisions and execution history. No
retention/destructive-cleanup job was introduced.

### Activation and historical safety

- Rules remain disabled by default. **Enable** requires explicit confirmation that
  future verified PR events can change linked task statuses. The server requires
  `automationConfirmed: true` on enabled create/update commands; otherwise 409.
- A successful confirmed save stores activation time, administrator ID and the exact
  new rule version in its audit snapshot. Editing an enabled rule needs confirmation
  again and starts a new boundary. Disabling/deleting clears the grant. Pending work
  for an older version will not be silently reinterpreted under the new definition.
- Existing M3.3 enabled rules have null grants and show **Preview only · confirmation
  required**. Old clients editing a version without renewing confirmation invalidate
  that version's grant. They cannot silently upgrade an automation definition.
- Both delivery receipt and source update time must follow activation (source time
  strictly later). GitHub timestamp precision is seconds; a same-second event can
  safely skip. Create the new test PR after confirmation. Future skew over five
  minutes and events over seven days old remain blocked by the shared evaluator.
- Existing receipts default to marker 0 even if pending/failed. Already PROCESSED
  rows are not scanned. Retrying an old delivery never upgrades its eligibility.
  Old observations remain available for dry-run; enabling a rule does not enqueue
  them. Never reset/replay PR #1's rows to test automation.
- Active administrator authorization is checked again before action; removing or
  demoting the authorizer blocks pending work. OAuth is not selected or required by
  the executor. The active verified repository connection and explicit workspace
  grant authorize the action; disconnect the connection to revoke that channel.
- Disabling/disconnecting and execution serialize on the project lock: an action
  already committed cannot be undone by a later disable. No automatic rollback or
  reverse task transition occurs.

### Status/activity and failure semantics

Only the requested task status plus version/updatedAt changes. The existing human
status semantics are reused: entering Done sets completedAt if absent, preserves
an existing completion time, and leaving Done clears it. Other task fields and
sprint membership are untouched. Already-at-target work is a no-op skip.

Task activity shows **GitHub automation moved DEV-002 from Todo to Done · PR #N ·
PR Merged → Done (v2)**. It has source GITHUB_AUTOMATION, actorId null and a unique
execution receipt, never the authorizing human as actor. Task history and workspace
feeds handle that explicit system source. The public Activity DTO's actor can now
be null for automation; human activity retains its existing representation.

Transient database errors use the existing capped exponential jitter/backoff and
`GITHUB_WORKER_MAX_ATTEMPTS` (default 8). At exhaustion the durable record becomes
FAILED. Permanent validation/authorization issues, disabled/edited rules, stale
sources, equal-priority conflicts, ambiguous/missing evidence and task version
conflicts are terminal skips/conflicts; they are not retried forever. Source
publication failures still use the original delivery retry/dead-letter machinery.
If the database is unavailable even for failure bookkeeping, the worker exits safely;
pending rows survive for restart and monitoring. No terminal execution-retry or
force-execution API exists; a new eligible event is required.

`--once` now budgets both delivery publication and automation stages (usually two
work items for one eligible PR). It drains only due work up to onceLimit and exits;
future backoff rows require the continuous worker or a later invocation. Graceful
shutdown drains in-flight transactions under the existing worker runtime.

### Administration and source inspection

Projects → project card → **Workflow rules** retains configuration/audit/preview.
New **Automation executions** provides outcome filtering, 25-row pagination, refresh,
original rule/version, task/status/version, repository/PR and sanitized reason.
Safe PR links are constructed from verified repository metadata, not payload URLs;
**Open task** uses the existing task detail dialog. The existing task GitHub section
and passive card badge remain unchanged. Kanban uses its existing 30-second snapshot
refresh; reload for an immediate read. Reopen/refetch task details for fresh activity.
No unsaved editor content is automatically overwritten by a new polling mechanism.

`GET /api/projects/:projectId/github-workflows/executions?workspaceId=...&state=APPLIED&offset=0`
requires current owner/admin authorization and returns no credentials/raw payloads.
Valid states are PENDING/APPLIED/SKIPPED/CONFLICTED/FAILED. There is no POST execution
endpoint. Previews never call the executor, and the eight AI tools/approval hashes
and receipts remain unchanged.

### Deployment and worker startup

First run the isolated verification commands in VERIFICATION.md. Then deliberately
apply the additive application migration; do not reset/push/seed:

```bash
# Stop old application/worker instances before upgrading all replicas.
# Manual application deployment only after devflow_test checks pass:
pnpm db:migrate
pnpm db:generate
pnpm github:worker:build
pnpm build:webpack
# Start the app using your normal dev/production command:
pnpm dev
# Separate terminal/service, after schema and worker build:
pnpm github:worker
# Or bounded processing (includes both stages):
pnpm github:worker --once
```

For production use the existing Node worker/service configuration and restart it
with the rebuilt `.worker` output. Mixed old receivers stamp 0 and cannot silently
create eligible actions; upgrade all web instances before enabling a rule. No new
webhook event subscription is needed if pull_request is already configured. Retain
existing signing secrets; no tokens or secret rotation was needed for M3.4.

### Live acceptance — NEW PR referencing DEV-002

These are manual owner actions; the agent did not perform them or claim live success.

1. Inspect **DEV-002** in DevFlow. Confirm it starts **Todo**, record its current
   version, assignee/priority/sprint and activity count. Confirm historical merged
   **PR #1** remains PROCESSED, rule v1 remains in its existing audit history, and
   no historical task change has occurred. Do not alter/reset its delivery rows.
2. In Projects → DevFlow → Workflow rules, inspect **PR Merged → Done** scoped to
   `jameelsikandar/25-react-projects`. Ensure other enabled rules do not conflict.
   Click **Enable**, read the scope/Done warning and confirm. It becomes a new
   confirmed version (normally v2); enabling itself must leave DEV-002 in Todo.
3. After confirmation, manually create a **new test PR** with `DEV-002` in its title
   or body. Merge that new PR. Do not re-use PR #1 as the source event. No AI approval
   request or new DevFlow task is involved.
4. In GitHub webhook deliveries, verify the new PR closed/merged event is accepted
   (202). Its new DevFlow receipt has automationVersion 1. Run the updated continuous
   worker (or enough `--once` work to cover both stages). Check delivery PROCESSED
   and the new PR's task association, then **Automation executions → applied**.
5. Refresh Board (or allow the normal 30-second refresh). DEV-002 appears in Done.
   Open the task → Activity and confirm one **GitHub automation moved DEV-002 from
   Todo to Done** entry with the new PR and confirmed rule version. Task version
   increments exactly once; expected completion-date semantics apply. Assignment,
   priority, title, description, scheduling and sprint fields must match step 1.
6. Redeliver the **new merged-PR webhook** in GitHub. Confirm no second status/version
   change or activity entry. Existing receipt/hash replay may produce no new row;
   semantically equivalent distinct deliveries may show a duplicate skip instead.
7. Verify PR #1's original observation/receipt/history remain unchanged and no APPLIED
   execution for that historical event exists. Restart the worker with no new events;
   it must not move DEV-002 again. Its old disabled-rule preview remains read-only.
8. Inspect execution history in desktop/mobile and both themes, safe PR/task links,
   and disabled/confirmation-cancel behavior. Disable the test rule when finished
   if you do not intend future automation. Disabling does not reverse Done.

Real GitHub and browser acceptance remain local gates. Unit mocks/browser fixtures
are not substitutes for this new-PR procedure. M3.5 operations/retention/alerting,
additional actions/conditions and unrelated milestones remain out of scope.

## M3.5 operational acceptance ledger — baseline 2026-11-15

The owner reports M1 through M3.4 complete. This ledger records the evidence available
for the new operational milestone; it does not negate those implementation reports
or infer fresh live acceptance from them. The current baseline uses branch
`feat/m3-5-operational-readiness` at `48d7b5c`. Details: VERIFICATION.md.

| Gate                                           | Evidence at this baseline                                                                                            | State                                                    |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Unit/static/build regression                   | 326 unit tests; schema/client, lint, worker and webpack checks pass; type/format results recorded in VERIFICATION.md | Available baseline evidence                              |
| Repository-wide formatting                     | Four unchanged source/test files fail the full formatter; changed milestone documents pass                           | Follow-up focused formatting change required             |
| Real SQL/concurrency/rollback                  | Guarded devflow_test run cannot reach localhost:5433; six setup failures, 82 skipped                                 | Blocked here; actual local result required               |
| Browser and visual acceptance                  | EPERM at localhost:3100 before server startup; 12 cases discovered, zero executed; no screenshots                    | Blocked here; desktop/mobile evidence required           |
| Signed ingestion and task association          | Historical owner-verified ping/push and commit/task linking retained in earlier records                              | Historical evidence; no new live action performed        |
| New eligible PR automation and redelivery      | M3.4 tests/runbook exist; no fresh M3.5 live execution evidence collected in this step                               | Pending separately authorized owner-run acceptance       |
| Idle/unavailable/bounded/unknown worker health | Existing logs/queue data; lightweight scoped monitoring is the next approved implementation step                     | Pending implementation and acceptance                    |
| Restart/recovery and revocation lifecycle      | Existing guards and mocked/integration scenarios; fresh operational process evidence not collected                   | Pending isolated and owner-run acceptance                |
| Explicit connection diagnostics                | Current transport/grants reused; no new revalidation operation yet                                                   | Pending implementation; no automatic retarget/disconnect |
| Retention impact                               | Current provenance/idempotency FKs identified; no cleanup introduced                                                 | Pending read-only report/policy; no deletion/archive     |
| Isolated CI and deployment evidence            | Example worker unit/runbook exists; no M3.5 Actions workflow yet                                                     | Pending implementation/execution; no push authorized     |

The next changes must reuse the existing PostgreSQL queue/executor and administrator
panels, exposing only authorized, sanitized metadata. OAuth authorization, webhook
verification and worker liveness are separate signals: one must not be fabricated
from another. An idle worker, bounded run or missing evidence must not trigger a
misleading failure claim. New health persistence, if needed, uses additive migrations
first verified on isolated devflow_test; no production migration is automatic.

Retention is read-only policy, dependency analysis and dry-run impact reporting.
Delivery uniqueness, semantic claims, immutable observations, task-link evidence,
rule snapshots and machine activity are protected data, not blanket TTL candidates.
No records may be removed or archived as part of this milestone. Existing failed
delivery retry controls remain authorized and bounded; no diagnostic may replay
processed/historical events or force a terminal task execution.

Fresh live lifecycle acceptance must use an explicitly authorized disposable test
scope. The existing M3.4 DEV-002 procedure documents earlier acceptance instructions;
it is not standing authorization to modify DEV-002 or enable its live rule. The
agent will not use live credentials, create hooks, revoke grants, merge PRs, enable
rules or silently change repository identity/connection state. Required external
actions remain owner-run or need separate explicit approval.

Step 1 pauses for the owner's documentation commit confirmation. M3.5 remains open
until the required tests and real acceptance gates are actually satisfied. Generic
workflow builders/email/actions, Redis, a GitHub App migration and M4 collaborative
documentation are outside the approved operational scope.
