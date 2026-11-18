# Isolated GitHub worker recovery rehearsal — TEST ONLY

**Prepared, not executed. Approval A remains blocked.** No commands below are
currently authorized. Production files, existing databases, connections, rules and
DEV-002 are outside this harness. No cleanup, live GitHub or Groq access is allowed.

## Approval A blockers and provenance

`provenance.json` contains owner-supplied evidence and deliberately retains
`approved: false`. The owner reports verification on Fedora x86_64 using official
Docker registry metadata and an independent pnpm archive SHA-512 calculation.
Codex has not independently retrieved or hashed those artifacts.

- Node: `node:22-bookworm@sha256:69c6e263db01e9946c7743bbbe9f7b1ba0df384d27ec09e08e5832d6acd3daf3`.
- PostgreSQL: `postgres:18-alpine@sha256:fa1b61f5a4844f4d4b73c9b15716cfc75fe70c931f2d32723630f3b900056366`;
  registry metadata reports PostgreSQL 18.7-alpine3.24.
- Both pins identify **Linux/amd64 platform manifests**, not multi-platform index
  digests or image configuration digests. The Node index/configuration hashes are
  retained separately in `reviewEvidence`.
- pnpm: official npm distribution `pnpm@11.9.0`, archive
  <https://registry.npmjs.org/pnpm/-/pnpm-11.9.0.tgz>. The owner-reported matching
  SHA-512 integrity is retained verbatim in the manifest.

The major Node tag is permitted only with an immutable SHA-256 pin; no patch label
is inferred. Official repository names, Node 22 Bookworm, PostgreSQL 18, digest
requirements and the explicit approval gate remain enforced. The `platform` field
records the intended target; it is not a new automatic host architecture check.
Runtime/image compatibility and the final owner review remain outstanding.

A later separately authorized change must record owner approval. Merely
flipping the boolean does not satisfy acceptance. Build validation compares the
Node base argument with the approved manifest; the downloaded pnpm tarball must
match its approved integrity before installation. Runtime and host admission also
reject unresolved provenance. The worker image ID and PostgreSQL image ID are
bound into the retained admission receipt/inventory. No mutable image-tag fallback
is provided. Availability and compatibility of these images remain unverified.

The Fedora procedure supports only `/usr/bin/docker` with the **local rootful**
`unix:///var/run/docker.sock` endpoint. Rootless/remote Docker is not silently
substituted. Host helpers use a dedicated empty Docker configuration and minimal
environment; they do not use the owner's Docker credential configuration. Image
pull/build requires separate Approval A and network access to package/image
registries. It never requires GitHub OAuth or AI credentials.

## Storage admission before PostgreSQL

`storage-admit.cjs` is inert on import. Its explicitly approved CLI:

- Requires successful positive Docker listings; any listing/inspection failure
  aborts. There is no inspection-error-to-absence conversion.
- Opens exclusive output/journal files before resource creation.
- Asks Docker to generate **anonymous 256-bit volume names**, without supplying a
  reusable name. Checks prior-name inventory, creation time, distinct identities,
  built-in `local` driver, zero driver options, local scope and run/role labels.
- Creates a retained, network-none, readonly-root admission container from the
  reviewed worker image, with only the two new volumes. Its configuration is
  inspected before startup. It has only CHOWN capability and no Docker socket.
- The probe requires ext4/XFS/Btrfs backing and actual mount roots matching the
  anonymous volume identities; NFS, remote/unknown filesystems and ambiguous roots
  are rejected. It checks **both roots are empty before any write**. It writes synthetic
  run/nonce/name markers and a receipt; it grants UID 1000 access to the evidence
  directory. The PostgreSQL-root marker sits outside PG18's actual data directory.
- Requires the probe's successful exit and explicit empty-storage result. Failure
  leaves resources/journal for review; it never deletes or starts PostgreSQL.

`storage-start.cjs` rechecks volume metadata and probe identity/exit before the
first PostgreSQL startup. It rejects any other container attached to these volumes,
requires the planned PG/controller names to be absent, and creates a one-use start
admission ticket. No PostgreSQL/database process is started by either host helper.
A failure or consumed ticket requires review and a new run; never reset/reuse it.

This establishes freshness through generated identity, positive inventory,
creation metadata, empty-root inspection and one-use admission, **not labels alone**.
It assumes a trusted Docker administrator and no concurrent resource manipulation.
A malicious administrator can forge metadata or alter backing storage; this is not
a security boundary against host root. Resource topology remains an attestation,
not continuous Docker policing. Reinspect before approved phases.

## Worker, operation and migration lifecycle

The image compiles the real worker CLI plus scoped health/workflow services and
regenerates Prisma from the lockfile. Host `.env`, host `node_modules`, existing PG
volumes, source/home bind mounts and Docker socket mounts are prohibited. The
production package worker commands load `.env`, and generated Prisma clients can
resolve schema-relative `.env`; never invoke those host commands for this exercise.

The image shell entrypoint rejects Node preload variables before starting Node.
Controller/child guards validate the exact synthetic URL/run, filesystem, readonly
root, non-root worker UID, resource/admission receipts and provenance before any
application import. Database metadata must identify the run database/role, PG18
and only the expected database/templates. Server statement/lock/idle-transaction
limits are verified. Migration bootstrap requires an empty public schema and adds
only a run-specific database marker; fixture/worker entry points check eight
completed checksummed migrations. No application/recovery/test database is accepted.

The fixed URL sets 5-second connection/pool waits, a 10-second socket timeout and
three connections. The fresh PG server sets 8-second statement, 3-second lock,
12-second idle-transaction and 5-second authentication limits. The test-only DB
proxy checks cancellation before/after every operation and transaction callback
query; transactions retain their real atomicity and have bounded waits/timeouts.
An already committed operation cannot be undone by a disconnected client: its
outcome is unresolved and cannot be advertised as successful.

The controller gives each operation a 240-second deadline. Predicate waits are
individually bounded. Client disconnection cancels the operation and persists an
UNRESOLVED latch. New dependent launches are rejected even if background work later
settles; controller restart also checks retained operation state. Failed/unresolved
reports remain readable. Explicit owned abort requests cannot clear the latch.
Only a new reviewed run/recovery decision can proceed. Gate waits are bounded;
IPC loss requests real worker abort/drain and blocks future claims. Final drain
uses a separate bounded cleanup budget, never a fresh fixture/scenario budget.

Migration opens its exclusive log before forking a guardian. The guardian validates
isolation before loading Prisma as its **actual main module** (Prisma 6.19 checks
`require.main === module`). It tracks Node-spawned schema-engine ChildProcess
objects and their lifecycles. Cancellation signals only owned handles; no arbitrary
PID or process-group signal is accepted. A conservative private-namespace inventory
also detects untracked/orphaned processes and PID reuse via process start time.
Unknown processes or failed inventory cause UNRESOLVED, not adoption or a false
success. Do not run extra Docker exec clients while migration is active: unexpected
namespace processes deliberately block completion.

The guardian must report zero remaining descendants, exit and close streams before
migration is accepted. Timeout/log failure requests owned termination and waits for
confirmed closure; unresolved work keeps dependent launches blocked. No automatic
SIGKILL escalation or resource deletion occurs. The operator must separately
approve container-level intervention if an engine or guardian cannot drain.

## Network and evidence boundaries

JavaScript fetch, HTTP(S), HTTP2 and ordinary JS TCP are rejected; only the owned
Unix control socket is allowed. The probe has no network. Runtime app/PG containers
use only the run's internal network, private PID/IPC namespaces, no published ports,
no added capabilities on the controller, and no OAuth/enrichment records.

These are layered restrictions, **not proof of universal OS-level HTTP denial**.
Native libraries/subprocesses are outside the JS monkey patches. Docker internal
networking is not a substitute for independently verified host-service/egress
firewall policy. Real GitHub enrichment takes its local-only branch because no
authorization exists. Runtime egress, native-engine behavior and host reachability
remain separate isolation acceptance checks; no external probes were performed.
HTTP violation markers invalidate scenario success and survive a killed worker.

Evidence contains selected state/count/timing/exit fields, not lease tokens, URLs,
raw payloads, user records or error strings. Raw migration diagnostics are confined
to a private synthetic-only log. `report` may succeed as a **diagnostic read** while
the report records FAILED/UNRESOLVED; that is never scenario acceptance. Inventory
never reads container environment. Reports, journals, images, containers and volumes
are retained. No automatic cleanup, prune, reset, seed or archive action exists.

## Scenarios and acceptance boundaries

| Area             | Real-path assertions prepared                                                                                         | Limits                                                   |
| ---------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Bootstrap        | Guarded identity, storage, SQL limits and eight migration checksums                                                   | Docker/bootstrap unexecuted                              |
| Idle/active      | Own worker health-run ID and completed persisted poll; real lease renewal                                             | Aggregate old heartbeat cannot establish readiness       |
| Graceful SIGTERM | Production abort observed, gated work drains, second event stays queued, zero validated exit, STOPPED signal          | Unexpected exits fail drain                              |
| Crash/expiry     | Actual SIGKILL, real database-clock lease expiry, unavailable then replacement health                                 | Crash occurs before publication transaction              |
| Stale owner      | B paused with new **active** lease; A's completion/renew/fail rejected; B token/state intact; then B publishes once   | No fabricated lease timestamps                           |
| Retry            | Positive bounded jitter window, durable due time, claim no earlier than due                                           | Timing window above 500ms fails as insufficient evidence |
| Dead letters     | Retry cap, permanent first-attempt failure, no reclaim after due time and new own poll                                | No task/object side effects                              |
| Duplicates       | Receipt count, one object/observation/task link/evidence, no task changes                                             | Sequential receipt replay                                |
| Automation       | One transition/version/activity/APPLIED execution; semantic duplicate SKIPPED; exact observation/link/evidence totals | Sequential replay; no mid-transaction OS kill            |
| Supervisor       | Owned replacement readiness and recovery; two-restart limit; intentional crashes distinguished                        | Local controller policy, not production systemd          |

No scenario has run. **Mid-transaction OS kill, post-commit/pre-ack crash, crash
between PR planning and automation execution, concurrent automation workers and
production systemd supervision are not covered by this harness execution.** The
unused `post-commit` gate is instrumentation only, not tested acceptance. Existing
application integration tests remain separate evidence and were not rerun here.

## Safe source-only verification

Only the separate pure config may be used under the current authorization. It has
`envDir: false` and no dotenv/application setup. Pure tests use fake Docker, IO,
child processes, SQL objects and transport objects; no real resources are touched.

```bash
node_modules/.bin/prettier --check rehearsal deploy/M3_5_ACCEPTANCE.md VERIFICATION.md
node_modules/.bin/eslint rehearsal
node_modules/.bin/tsc --noEmit --incremental false
node_modules/.bin/tsc --noEmit --incremental false -p tsconfig.core.json
node_modules/.bin/tsc --noEmit --incremental false -p rehearsal/tsconfig.json
node_modules/.bin/vitest run --config rehearsal/vitest.config.ts
for file in rehearsal/*.cjs; do node --check "$file" || exit 1; done
sh -n rehearsal/entrypoint.sh
git diff --check
```

The normal `pnpm test` glob does not discover `rehearsal/*.test.ts`; do not substitute
its result. No existing integration config (which loads `.env`) may run here.

## Future Fedora procedure — NOT AUTHORIZED FOR EXECUTION

All steps require a separate approved scope and reviewed committed source. The
reviewed preparation-only harness and unapproved provenance are not execution-ready.
Approvals: A build/storage/bootstrap; B synthetic fixtures/idle/processing; C owned
signals/faults/recovery; D synthetic automation; E stopping resources, followed by
separate itemized deletion approval. CLI scopes enforce deliberate selection; they
do not replace owner authorization. Never run against an existing database.

After owner review of provenance, review this sequence again before Approval A:

```bash
set -euo pipefail
run_id="$(date -u +%Y%m%dT%H%M%SZ)_$(openssl rand -hex 4)"
rehearsal_root="$(mktemp -d /tmp/devflow-worker-rehearsal.XXXXXXXX)"
chmod 700 "$rehearsal_root"
mkdir "$rehearsal_root/source" "$rehearsal_root/docker-empty" "$rehearsal_root/registry-empty"
node_bin="$(command -v node)"
rehearsal_node() { env -i PATH=/usr/bin:/bin HOME="$rehearsal_root" "$node_bin" "$@"; }
rehearsal_docker() { env -i PATH=/usr/bin:/bin HOME="$rehearsal_root" /usr/bin/docker \
  --host unix:///var/run/docker.sock --config "$rehearsal_root/registry-empty" "$@"; }
git rev-parse HEAD > "$rehearsal_root/source-revision.txt"
git archive HEAD | tar -x -C "$rehearsal_root/source"
plan="$(rehearsal_node rehearsal/resources.cjs plan "$run_id")"
printf '%s\n' "$plan" > "$rehearsal_root/plan.json"
rehearsal_db="$(jq -r .database <<<"$plan")"
rehearsal_net="$(jq -r .network <<<"$plan")"
rehearsal_pg="$(jq -r .postgres <<<"$plan")"
rehearsal_control="$(jq -r .controller <<<"$plan")"
node_image="$(jq -er '.nodeImage' rehearsal/provenance.json)"
pg_image="$(jq -er '.postgresImage' rehearsal/provenance.json)"
# Review approved digests before these separately authorized registry/build actions.
rehearsal_docker pull "$pg_image"
rehearsal_docker build --build-arg "NODE_IMAGE=$node_image" \
  -f "$rehearsal_root/source/rehearsal/Worker.Dockerfile" \
  -t "devflow-worker-rehearsal:$run_id" "$rehearsal_root/source"
rehearsal_image="$(rehearsal_docker image inspect "devflow-worker-rehearsal:$run_id" --format '{{.Id}}')"
# Creates ONLY fresh anonymous volumes and the retained network-none probe.
rehearsal_node rehearsal/storage-admit.cjs "$run_id" --approve storage \
  "$rehearsal_image" "$rehearsal_root/admission.json"
# Review journal, successful probe and anonymous volume identities; then revalidate.
rehearsal_node rehearsal/storage-start.cjs "$run_id" --approve postgres-start "$rehearsal_root/admission.json"
rehearsal_data="$(jq -er .volumes.data.name "$rehearsal_root/admission.json")"
rehearsal_evidence="$(jq -er .volumes.evidence.name "$rehearsal_root/admission.json")"
# Admission must have SUCCEEDED before PostgreSQL starts. No existing volumes allowed.
rehearsal_docker network create --internal --label "devflow.rehearsal=$run_id" "$rehearsal_net"
rehearsal_docker run -d --pull=never --name "$rehearsal_pg" --label "devflow.rehearsal=$run_id" \
  --network "$rehearsal_net" --network-alias worker-pg --ipc private \
  --mount "type=volume,source=$rehearsal_data,target=/var/lib/postgresql" \
  -e POSTGRES_USER=worker_fixture_admin -e POSTGRES_PASSWORD=fixture_only \
  -e "POSTGRES_DB=$rehearsal_db" \
  --health-cmd="pg_isready -U worker_fixture_admin -d $rehearsal_db -h 127.0.0.1" \
  --health-interval=2s --health-retries=30 "$pg_image" \
  postgres -c statement_timeout=8000 -c lock_timeout=3000 \
  -c idle_in_transaction_session_timeout=12000 -c authentication_timeout=5s
# Explicit bounded readiness; only a healthy final TCP server permits continuation.
ready=false
for attempt in {1..60}; do
  state="$(rehearsal_docker container inspect "$rehearsal_pg" --format '{{.State.Health.Status}}')"
  if [ "$state" = healthy ]; then ready=true; break; fi
  [ "$state" != unhealthy ] || exit 1
  sleep 1
done
[ "$ready" = true ] || exit 1
rehearsal_docker run -d --pull=never --name "$rehearsal_control" --label "devflow.rehearsal=$run_id" \
  --network "$rehearsal_net" --ipc private --read-only --user node --cap-drop ALL \
  --security-opt no-new-privileges --tmpfs /tmp:rw,nosuid,nodev,size=64m \
  --mount "type=volume,source=$rehearsal_evidence,target=/evidence" \
  -e NODE_ENV=test -e "REHEARSAL_RUN_ID=$run_id" -e "REHEARSAL_DATABASE=$rehearsal_db" \
  -e "DATABASE_URL=postgresql://worker_fixture_admin:fixture_only@worker-pg:5432/$rehearsal_db?schema=public&connect_timeout=5&pool_timeout=5&socket_timeout=10&connection_limit=3" \
  -e "TOKEN_ENCRYPTION_KEY=$(printf 'ab%.0s' {1..32})" \
  -e APP_URL=http://127.0.0.1:1 -e GITHUB_DEMO=false \
  -e AI_API_KEY= -e GITHUB_CLIENT_ID= -e GITHUB_CLIENT_SECRET= "$rehearsal_image"
rehearsal_node rehearsal/inventory.cjs "$run_id" "$rehearsal_root/admission.json" > "$rehearsal_root/resources.json"
rehearsal_node rehearsal/resources.cjs validate-start "$run_id" < "$rehearsal_root/resources.json"
rehearsal_docker exec -i "$rehearsal_control" node rehearsal/controller.cjs \
  configure-inventory --approve inventory < "$rehearsal_root/resources.json"
rehearsal_docker exec "$rehearsal_control" node rehearsal/controller.cjs verify-isolation
# Do not run any other exec client until migration has returned.
rehearsal_docker exec "$rehearsal_control" node rehearsal/controller.cjs migrate-disposable --approve bootstrap
```

Any error aborts the sequence; retain resources/journals. Never resolve/reset/reseed
a failed target or substitute another connection. A consumed admission ticket is
not permission to retry/restart PG. Revalidation is read-only; explicit startup
permission remains required. No Docker socket or host filesystem is mounted into
any rehearsal container.

### B–D. Individually approved scenarios

```bash
# Approval B:
rehearsal_docker exec "$rehearsal_control" node rehearsal/controller.cjs create-fixtures --approve fixtures
rehearsal_docker exec "$rehearsal_control" node rehearsal/controller.cjs run idle-active --approve workers --retain
rehearsal_docker exec "$rehearsal_control" node rehearsal/controller.cjs run duplicate-events --approve workers --retain
# Approval C:
rehearsal_docker exec "$rehearsal_control" node rehearsal/controller.cjs run graceful-shutdown --approve signals --retain
rehearsal_docker exec "$rehearsal_control" node rehearsal/controller.cjs run crash-recovery --approve faults --retain
rehearsal_docker exec "$rehearsal_control" node rehearsal/controller.cjs run stale-owner-fencing --approve faults --retain
rehearsal_docker exec "$rehearsal_control" node rehearsal/controller.cjs run retry-backoff --approve faults --retain
rehearsal_docker exec "$rehearsal_control" node rehearsal/controller.cjs run dead-letter --approve faults --retain
rehearsal_docker exec "$rehearsal_control" node rehearsal/controller.cjs run supervisor-restart --approve faults --retain
# Approval D:
rehearsal_docker exec "$rehearsal_control" node rehearsal/controller.cjs run automation-idempotency --approve automation --retain
# Diagnostic read only; FAILED/UNRESOLVED stays visible and is never a test pass.
rehearsal_docker exec "$rehearsal_control" node rehearsal/controller.cjs report > "$rehearsal_root/report.jsonl"
```

## Failure handling and cleanup restrictions

Only explicitly expected, validated exits are accepted. A scenario failure drains
owned children with SIGTERM and releases gates; it never deletes data/resources.
Only an explicitly approved `abort-owned --approve faults` may kill recorded owned
workers. Migration cancellation uses its guardian and owned descendant handles;
unknown/unresponsive work stays unresolved. No automatic SIGKILL fallback exists.

Do not stop containers during operations. After separate Approval E and confirmed
process drain, stop the exact reviewed controller/PG containers. Never use Compose
down, label-wide removal or prune. Keep the stopped admission probe too. Read-only
inventory/cleanup validation after approved stops:

```bash
rehearsal_node rehearsal/inventory.cjs "$run_id" "$rehearsal_root/admission.json" --stopped > "$rehearsal_root/stopped-resources.json"
jq -n --slurpfile original "$rehearsal_root/resources.json" \
  --slurpfile current "$rehearsal_root/stopped-resources.json" \
  '{original:$original[0],current:$current[0]}' | \
  rehearsal_node rehearsal/resources.cjs validate-cleanup "$run_id"
```

The validator compares IDs, storage creation metadata, backing policy, probe and
stopped state. Docker has no volume UUID: anonymous identity plus immutable receipt
and timestamps is not a defense against malicious host-root recreation. It always
returns `deletionAuthorized: false`. Review each retained volume/container/network,
image, source archive and evidence file; obtain separate deletion approval. No
cleanup implementation is supplied. The retained development backup/recovery
artifacts and all existing databases are outside this inventory.
