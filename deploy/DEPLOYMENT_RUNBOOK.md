# DevFlow deployment and operations runbook

This is an operator procedure, **not evidence of a deployment**. No commands in
this guide were executed against application data during M3.5 Step 9. Deployment,
worker startup, live GitHub reads/writes and changes to connections/rules require
separate operator authorization. Preserve DEV-002 and its history. Current gates
and evidence are in [M3.5 acceptance](M3_5_ACCEPTANCE.md) and
[verification](../VERIFICATION.md).

## Architecture and prerequisites

Deploy one versioned release containing the Next.js Node application and a separate
long-running Node GitHub worker. Both use the same PostgreSQL schema and encryption
key. Next.js never launches the worker. PostgreSQL holds sessions, task activity,
verified webhook receipts, leases, observations, execution history and health signals.
No Redis, queue service or external scheduler is required. A request-only/serverless
web deployment still needs a separately supervised persistent worker.

Use the pinned pnpm 11.9.0 and tested Node 22.23.1 toolchain for builds; package.json
currently declares Node >=22.12.0. Retain the pnpm lockfile and build allowlist.
Provide a reachable PostgreSQL service, backup/restore capability, HTTPS reverse
proxy and a restricted OS service account. Size Prisma connection pools for all
web/worker replicas, not just worker concurrency. Keep clocks synchronized; event
age and freshness checks are operational safeguards.

Local compose.yaml uses postgres:18-alpine on loopback port 5433 with a named
persistent volume. CI uses PostgreSQL 16 on an ephemeral runner. These are distinct
environments; CI is not an upgrade test of every production PostgreSQL version.
Do not change a populated database's major version or remove its Docker volume as
part of this runbook. Rehearse the chosen production version separately.

## Environment and secret handling

Use [.env.example](../.env.example) as the inventory, not as usable configuration.
Keep production values in a protected deployment environment or an external-to-repo
0600 environment file. Do not print URLs, tokens, cookies, webhook bodies or secret
files. systemd EnvironmentFile syntax is not a shell script: do not blindly source
it. Supply the same reviewed settings to migration, web and worker processes.

| Setting                                 | Deployment requirement                                                                                                          |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| DATABASE_URL                            | Explicit intended PostgreSQL database; use deployment-appropriate TLS/access restrictions. Never derive it from a test URL.     |
| APP_URL                                 | Exact public HTTPS origin, no path/trailing slash; browser Origin and OAuth callback must agree.                                |
| NODE_ENV                                | production for deployed web/worker services; production sessions/OAuth state cookies require HTTPS.                             |
| TOKEN_ENCRYPTION_KEY                    | Existing 64-hex-character AES-GCM key, identical on every replica. Preserve a protected backup with the database recovery plan. |
| GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET | Server-side OAuth app configuration when GitHub is used. Callback is APP_URL/api/github/callback.                               |
| AI_API_KEY / AI_BASE_URL / AI_MODEL     | Optional; compatible tool-calling provider. Leave key unset when unused; no fake AI acceptance.                                 |
| AI_DIAGNOSTICS                          | Optional sanitized aggregate diagnostics, off by default; never turn on body/credential logging.                                |
| GITHUB_DEMO                             | false in deployment.                                                                                                            |
| TEST_DATABASE_URL                       | Only integration/browser verification; separate devflow_test. Omit from production service environments.                        |
| POSTGRES_PASSWORD                       | Local Compose bootstrap only; not a credential-rotation mechanism for an existing volume.                                       |
| SEED_PASSWORD                           | Disposable evaluation seed only; do not seed or invoke cleanup scripts during deployment.                                       |

Never regenerate TOKEN_ENCRYPTION_KEY on each release. Losing/replacing it makes
stored OAuth tokens and per-connection webhook secrets unreadable. Restoring the
old key may recover readability; key rotation/re-encryption needs a separate plan.
OAuth account authorization, webhook HMAC verification and worker health are three
independent checks. A successful one does not establish the other two.

Worker options (server-side):

| Variable                    | Default | Allowed range / interpretation                                              |
| --------------------------- | ------- | --------------------------------------------------------------------------- |
| GITHUB_WORKER_CONCURRENCY   | 2       | 1–8 simultaneous processing attempts                                        |
| GITHUB_WORKER_LEASE_SECONDS | 120     | 30–900; delivery lease renewal occurs during processing                     |
| GITHUB_WORKER_MAX_ATTEMPTS  | 8       | 1–20 bounded attempts                                                       |
| GITHUB_WORKER_POLL_MS       | 2000    | 250–60000 ms                                                                |
| GITHUB_WORKER_ONCE_LIMIT    | 25      | 1–1000 attempts in --once, shared across delivery/execution stages          |
| GITHUB_WORKER_CONNECTION_ID | Unset   | Optional exact connection ID; omit completely when unused, not empty string |

## Pre-deployment and release order

1. Approve a release SHA and maintenance/rollback owner. Record current application
   and worker versions, migration status, public origin and secret/key continuity.
   Review existing enabled rules and queued work without changing them. Starting a
   worker can apply **already authorized** due automation; --once is not a safe
   read-only health probe. No rule enablement is part of deployment.
2. Obtain isolated devflow_test results and required CI/browser acceptance from the
   [acceptance checklist](M3_5_ACCEPTANCE.md). These never run on application data.
3. Create and verify a protected database backup outside the repository, including
   migration history; retain the matching encryption key separately. Validate a
   restore in a separate recovery database. Do not restore over the live database
   as a deployment check. Record recovery point/time objectives with the operator.
4. Build an immutable release directory from the approved SHA, without real .env,
   developer output or local databases. Install the full build dependencies before
   compiling; Prisma/TypeScript are dev dependencies. Keep the previous artifact.

```bash
# Build environment only; provider keys can remain unset.
pnpm install --frozen-lockfile
pnpm exec prisma validate
pnpm db:generate
pnpm github:worker:build
pnpm build:webpack
```

Include .next, public, .worker, generated Prisma Client/engines and runtime
node_modules with the release. This project does not configure Next standalone
output. Do not copy only .next or omit .worker. Build in a separate release path,
never over the running dev/production server's .next directory. Runtime should not
need tsx; direct compiled worker execution uses Node. Retain migration tooling in a
separate deployment environment if runtime dependencies are pruned.

5. Drain/stop old worker processes and old web replicas for the maintenance window.
   If ingress is unavailable, GitHub deliveries may fail: record their IDs for an
   explicit later redelivery of genuinely unaccepted events. Do not assume automatic
   redelivery. Already accepted events remain durable. Avoid mixed worker versions.
6. With the **deliberately selected deployment environment**, verify target identity
   through a protected PostgreSQL service profile, then inspect migrations. Example
   profile devflow_deploy must already be configured outside the repo; verify it
   identifies the same target as DATABASE_URL without printing credentials:

```bash
# Operator-only, after backup/target review. No password in command arguments.
psql 'service=devflow_deploy' -X -c 'SELECT current_database(), inet_server_addr(), inet_server_port();'
pnpm exec prisma migrate status
# Run only after resolving the target and reviewing all pending SQL migrations:
pnpm db:migrate
pnpm exec prisma migrate status
```

There are eight source-controlled migrations, in order: initial; roadmaps; agent
manager; webhook foundation; GitHub processing; workflow definitions; workflow
execution; worker health. The latest is 202611150003_github_worker_health. Step 9
adds **no migration**. Apply pending migrations once with a deployment identity,
never concurrently from every replica. Existing application records must survive.
A matching schema is not proof that every deployment/database backup is current.

7. Start the rebuilt web app, then the rebuilt worker **only after** schema and
   automation-backlog review. All replicas must share APP_URL/key/schema. Example
   commands below are future operator actions, not verification commands:

```bash
# Supervised web service environment includes NODE_ENV=production.
pnpm start --hostname 127.0.0.1 --port 3000
# Separate supervised process, same reviewed deployment environment:
node .worker/scripts/github-worker.js
```

## Process supervision and graceful recovery

[devflow-github-worker.service](devflow-github-worker.service) is an example, not an
installed service. Adapt User/Group, WorkingDirectory, EnvironmentFile and ExecStart
for the release path. Verify the Node executable is the tested version and readable
by the service identity; /usr/bin/node is a placeholder, and a user's fnm path under
/home will conflict with ProtectHome=true. Do not put secrets in unit files or CLI
arguments. The worker needs database/network access, not source-directory writes.

Use separate web and worker service names and independent restart policies. For a
web systemd unit use Type=simple, a dedicated user, the release working directory,
Environment=NODE_ENV=production, a protected EnvironmentFile and direct ExecStart
of Node plus node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port 3000.
Allow only the writable Next.js runtime cache paths your deployment requires; do
not blindly copy the worker's read-only filesystem policy to the web process.
Neither service runs migrations at startup. Example web unit content (review paths,
account and Node version first; this is documentation, not an installed service):

```ini
[Unit]
Description=DevFlow Next.js application
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=devflow
Group=devflow
WorkingDirectory=/opt/devflow
Environment=NODE_ENV=production
EnvironmentFile=/etc/devflow/devflow.env
ExecStart=/usr/bin/node /opt/devflow/node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port 3000
Restart=on-failure
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=90
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

Verify both units with systemd-analyze verify before an explicitly approved
installation/start. For an approved installation the operator places reviewed
units under /etc/systemd/system, performs daemon-reload and deliberately starts
the web service followed by devflow-github-worker.service. Inspect each service's
status/journal separately; do not enable/start anything merely to check this guide.

The example worker uses Restart=on-failure, RestartSec=5, SIGTERM and a 90-second
stop timeout. Review that timeout against observed request/transaction/drain times;
90 seconds is not a guarantee for all databases/options. SIGTERM/SIGINT stops new
claims and drains current work, then closes Prisma. If the supervisor force-kills
or the host fails, stale RUNNING evidence and leases remain until recovery.
PostgreSQL lease fencing rejects stale publishers. On a later healthy start the
worker recovers expired deliveries; pending automation remains durable. External
requests occur outside long transactions; status/activity/audit commit atomically.
Processing is at-least-once with idempotent effects, not exactly-once delivery.

--once exits after its budget or no immediately due work, and may leave future
backoff work or the next processing stage pending. A zero exit code does not imply
an empty queue or continuous availability. Use continuous supervision for service.
Inspect sanitized started/stopped/fatal/job codes in restricted service logs; this
app has no external alert dispatcher, public worker probe or automatic repair bot.

## HTTPS, OAuth and webhook routing

Terminate HTTPS at the deployment proxy, keep PostgreSQL and the Node port private,
and serve one canonical APP_URL. Preserve cookies/Origin, streaming responses and
raw webhook request bytes; do not parse/re-encode webhook JSON. Avoid buffering SSE
and allow its four-minute connection rotation/reconnect. Review proxy timeouts and
body limits against application/webhook limits; do not weaken server validation.

For **new, separately approved** GitHub setup, configure the OAuth callback as
https://YOUR_ORIGIN/api/github/callback. An authenticated administrator connects
an authorized repository in the existing GitHub UI. Fresh GitHub repository admin
permission and DevFlow workspace owner/admin are required. Classic OAuth currently
requests repo read:user. OAuth login is not permission to register webhooks.

The UI provides https://YOUR_ORIGIN/api/github/webhooks/CONNECTION_ID and a separate
one-time secret. An authorized repository administrator manually configures a JSON
webhook with TLS verification enabled. Supported subscribed events are push,
pull_request, issues and workflow_run; ping is handled safely. Preserve existing
hook URLs/secrets when the origin/connection is unchanged. Do not create duplicate
hooks, rotate secrets or change repository identity as part of an ordinary release.
Webhook signatures are HMAC SHA-256 over raw bytes, compared in constant time;
repository identity and duplicate delivery/payload guards remain enforced.

## Post-deployment smoke checks

These are operator observations on the intended deployment, not permission to
create data, call GitHub or enable rules. Record SHA/time/scope and sanitized results:

- GET /login returns the expected page over HTTPS; sign in with an existing
  authorized account. Check secure cookies, canonical origin and no session leakage.
- Existing Board, Tasks, roadmap, task details and GitHub activity load without
  editing DEV-002 or any task. Non-admins cannot see operational controls.
- Administrator GitHub panel health has a fresh asOf and matching scope; queue
  backlog/oldest due, retry/dead-letter and execution outcomes are interpretable.
- Health distinguishes Healthy idle (recent continuous heartbeat **and poll**) from
  Active, Unavailable, Bounded run and Insufficient evidence. A default heartbeat
  interval is 10 seconds; stale threshold is max(45 seconds, 3 × pollMs + 10 seconds).
  Fresh heartbeat without a fresh poll is insufficient evidence, not healthy idle.
  Disconnected/archived scope overrides worker classification. Check DB/host clocks.
- A 7/30/90-day retention GET is read-only and scoped. An incomplete report has
  unknown totals/candidates, never zero eligibility. No cleanup control exists.
- Revalidation is an explicit external read by the appropriate administrator only;
  do not click it as an automatic smoke step without live-read authorization.
- Verify webhook receipts/worker progress from already authorized evidence. A new
  test event, replay or automation journey needs the separate disposable-scope
  approval described in the acceptance checklist.

## Troubleshooting and recovery

| Symptom                                                                         | Evidence and safe next action                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OAuth callback/login failure                                                    | Check exact HTTPS APP_URL/callback, authenticated user and 10-minute state cookie. Do not weaken state/Origin checks. Confirm client configuration privately.                                                                                                                                     |
| Authorization rejected (401)                                                    | Revalidation cannot distinguish expired from revoked solely from 401. Request explicit account reauthorization by its owner; do not borrow another member's token.                                                                                                                                |
| Repository inaccessible (403/404) or permission missing                         | 404 may hide a private repo; it does not prove deletion. Check GitHub permissions/SSO and explicit enrichment authorizer. Do not silently retarget/reconnect or overwrite numeric repository identity.                                                                                            |
| Revalidation identity mismatch, unreadable credentials or inconclusive response | Check key continuity and original repository/account identity. Preserve settings. Resolve with an administrator; retry explicitly only after cause/cooldown is understood.                                                                                                                        |
| Webhook not accepted                                                            | Check HTTPS path/connection, TLS/proxy raw-body handling, event subscription and delivery result. Invalid signature/unsupported event/wrong repo must remain rejected. Never log/copy secrets or remove replay receipts.                                                                          |
| 202 but no activity yet                                                         | 202 means durable accepted receipt, not processed/task changed. Inspect due/scheduled queue, connection scope, worker evidence and task references; ping produces no task activity.                                                                                                               |
| Worker unavailable or stale poll                                                | Inspect supervisor status, exit/error code, database reachability, service env/Node path and configured connection restriction. Check health asOf/staleness before declaring outage. Do not restart-loop against a broken DB.                                                                     |
| Worker restarts or expired leases                                               | Restore DB/process availability, start the same reviewed release under supervision and observe fenced lease recovery. Do not clear lease tokens/attempts manually or force processed records pending.                                                                                             |
| Scheduled retries/dead letters                                                  | FAILED without deadLetteredAt is scheduled; terminal failures have a timestamp. Inspect sanitized code/availableAt and resolve the cause. Explicit administrator retry is for eligible failed deliveries only; it resets the budget and has audit consequences. Never blanket-retry all receipts. |
| Automation conflicted/skipped/failed                                            | Inspect immutable execution/rule versions, task baseline, priority conflicts, activation boundary, event age, source evidence and connection status. Do not force APPLIED, modify task versions or replay historical events. Terminal execution outcomes are not a generic retry queue.           |
| GitHub rate limit/timeouts                                                      | Honor observed Retry-After/reset and local cooldown; do not poll revalidation repeatedly (3 requests per administrator/connection/minute limit). Missing timing is inconclusive, not an invented countdown. Local webhook facts can process without enrichment; no unauthorized token fallback.   |
| Retention timeout/incomplete report                                             | Retain unknown/partial status and narrow the reviewed scope if possible. Category scan cap is 10,000, not total eligibility. Preserve provenance/replay/active/unresolved/audit records; never delete/archive based on this report.                                                               |

### Failed deployment or migration

Stop new rollout and keep workers stopped when schema compatibility is uncertain.
Record sanitized stage/code and inspect prisma migrate status, \_prisma_migrations
and reviewed SQL with the database operator. Do not use reset, db push, reseed,
forcefully edit migration receipts, or mark a migration resolved without inspecting
actual SQL effects. Some failures may leave partial effects; transaction behavior
must be checked against the specific migration. Rehearse an additive forward repair
in an isolated restored copy, obtain approval, then apply it deliberately.

Code rollback is a return to a retained, schema-compatible application **and**
worker artifact, preserving DATABASE_URL, encryption key and durable queue/audit
records. Stop/drain new processes before switching both. Verify old code understands
the current schema/automation semantics; if not, hold the worker and prefer a forward
fix. Do not run reverse migrations or remove the worker-health tables as rollback.
A rollback does not undo already applied task changes. Database restoration is an
incident procedure with explicit approval and a data-loss/reconciliation plan; first
restore into a separate recovery database. It is not the normal rollback command.

After outage recovery, observe fresh continuous heartbeat/poll and due-work progress,
check retries/dead letters/execution conflicts and idempotency evidence, and record
the incident timeline. Do not replay old M3.3 PR observations to prove recovery.
