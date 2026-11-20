# M3.5 isolated worker rehearsal — consolidated acceptance draft

**Verdict: PASS for the isolated A–D rehearsal scope. M3.5 overall operational and
production acceptance remains open.** This draft is for owner review, not a release
approval, deployment instruction or cleanup authorization.

## Evidence identity and review method

- Approved source: `bcd23ddd4828bab6f3e9e905db63b506977928c6`.
- Run: `20261120T124232Z_b5dbb420`.
- Retained root: `/tmp/devflow-worker-rehearsal.hTQeKwyy`.
- A: `approval-a-report.jsonl`.
- B: `approval-b.XJdmxtoR`.
- C: `approval-c.wboaRocF`.
- D: `approval-d.Bwu7yDrp`.

The reviewer read the retained source record, original inventory, all 20 JSONL
report/preflight/before snapshots across A–D, eight scenario command logs and three
checksum manifests. The source record matches the approved commit. Six selected
archived controller/policy/scenario/fixture/inventory/provenance files were compared
byte-for-byte against that commit and match. This is not a complete image-to-source
attestation or an independent inspection of current Docker state.

All report snapshots begin with `COMPLETED`, with no `OPERATION_FAILED` event or
`UNRESOLVED` state entry. Eight command logs end in successful `COMMAND_COMPLETE`.
The final D report contains exactly eight distinct `SCENARIO_COMPLETE` receipts,
each occurring once with `ok: true`. Reports are cumulative; repeated observations
of the same receipt in earlier snapshots are not additional executions.

This review performed file reads, JSON validation and SHA-256 comparisons only.
No Docker operation, database query/write, migration, worker, test suite, provider
request or cleanup was executed. No evidence was altered or copied into Git.

## Passed scope

| Stage | Evidence                                                                                | Accepted result                                                                                                                                        |
| ----- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A     | `INVENTORY_ACCEPTED`, `BOOTSTRAP_ISOLATED`, `MIGRATIONS_READY` count 8, completed state | Recorded isolated storage/inventory checks and disposable PostgreSQL migration bootstrap passed.                                                       |
| B     | `idle-active`                                                                           | Own-worker readiness, heartbeat progression, real processing/lease renewal and publication passed; report records `HEALTHY_IDLE` and `HEALTHY_ACTIVE`. |
| B     | `duplicate-events`                                                                      | Delivery-ID/body replay caused no duplicate durable effects; synthetic task remained unchanged.                                                        |
| C     | `retry-backoff`                                                                         | Transient failure, positive bounded scheduling, no early claim and eventual successful retry passed.                                                   |
| C     | `dead-letter`                                                                           | Retry cap, permanent first-attempt failure, no reclaim after due-time/new-poll evidence and no publication/task effects passed.                        |
| C     | `graceful-shutdown`                                                                     | SIGTERM was observed, in-flight work drained, further claiming stopped and shutdown evidence passed.                                                   |
| C     | `stale-owner-fencing`                                                                   | Real lease expiry/unavailable health, active replacement ownership and rejection of stale completion/renewal/failure passed before one publication.    |
| C     | `supervisor-restart`                                                                    | Actual SIGKILL before publication, replacement processing and bounded restart exhaustion passed.                                                       |
| D     | `automation-idempotency`                                                                | Synthetic merged-PR automation produced one task version/activity change; duplicate handling and unrelated-field preservation passed.                  |

These results combine receipts with inspection of the corresponding assertions in
[scenarios.cjs](../rehearsal/scenarios.cjs), [assertions.cjs](../rehearsal/assertions.cjs)
and [processes.cjs](../rehearsal/processes.cjs). The reviewer did not independently
query database records. The report explicitly records `FENCED` with completion,
renewal and failure all false, and `TASK_TRANSITION` with version 1/count 1.

The separate `crash-recovery` scenario was not executed. Crash recovery evidence
comes from the supervisor's SIGKILL/reclaim journey plus the fencing scenario's
expiry/unavailable/replacement checks. This does not establish every crash window.

## Evidence integrity

All six entries in the following three checksum manifests match their retained
files at review time:

- B: `approval-a-report.sha256`.
- C: `prior-evidence.sha256`.
- D: `prior-evidence.sha256`.

This independently corroborates current integrity against the stored stage
checksums. The owner's statement that checks remained unchanged during subsequent
stages is execution evidence supplied by the owner; current hashes alone cannot
prove every intermediate moment. The live controller ledger legitimately grew;
the frozen prior-stage exports remain preserved.

Paths below are relative to the retained root. These hashes identify report bytes,
not image manifests, database dumps or signed third-party attestations.

| Report                                                    | SHA-256                                                            |
| --------------------------------------------------------- | ------------------------------------------------------------------ |
| `approval-a-report.jsonl`                                 | `0306026b9898758f7b233e8d32f43cf8dd678fa02b7d3ee3200823eab8fb2b6f` |
| `approval-b.XJdmxtoR/idle-active.report.jsonl`            | `eaf7b03633c981f668c9b531eefdd956edcd633a2aa093b5dbc5bb147a9dc3b1` |
| `approval-b.XJdmxtoR/duplicate-events.report.jsonl`       | `4b94f4e9fdc7f91cc60136a6e02c0bdff02f720ab70331b5872447dc6dc1b884` |
| `approval-c.wboaRocF/retry-backoff.report.jsonl`          | `d3af06299f5a4950ef37dc295a745d47d6f7a95174be45e8d16eafcffaf34878` |
| `approval-c.wboaRocF/dead-letter.report.jsonl`            | `474027a2d98c9a6367a50cec85872021daf7637c23b4836355ea2c8650faf614` |
| `approval-c.wboaRocF/graceful-shutdown.report.jsonl`      | `dae77180463eda3f2005987ea5f838d3881355a583a30e0324cb42499169e913` |
| `approval-c.wboaRocF/stale-owner-fencing.report.jsonl`    | `ce7c1bc1744a20063cbb733a19af4c33f9a13e9a25f612cbaa4e9b38a3ec119f` |
| `approval-c.wboaRocF/supervisor-restart.report.jsonl`     | `b0622373aff158069c32b85fbd3a924fa275bf831c2b297c6eca218a056e63c2` |
| `approval-d.Bwu7yDrp/automation-idempotency.report.jsonl` | `f4e1a86186e9b8d82ddacf6f37c8a855f3ecf0c36a1bda3990ca7b30680760ef` |

## Remaining acceptance gates

The [existing acceptance checklist](M3_5_ACCEPTANCE.md) and
[deployment runbook](DEPLOYMENT_RUNBOOK.md) remain applicable. Earlier blocked or
unexecuted worker statements there are historical relative to this report; do not
interpret them as new failures or mark unrelated gates complete.

| Gate                            | Status and smallest remaining action                                                                                                                                                                                                                                                                               |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Encryption-key custody          | Open. Separately approve secure backup/custodian/recovery access and isolated decryption continuity using the correct key; record success without key/plaintext disclosure. Logical database restore alone is insufficient.                                                                                        |
| Rollback compatibility          | Open. Choose old/new application and worker artifacts plus compatible schema; rehearse recovery/rollback in disposable scope without blindly reversing additive migrations or losing accepted jobs.                                                                                                                |
| Real GitHub integration         | Earlier OAuth/webhook/linking/revalidation results retain their historical scope. Synthetic D is not a real PR. Separately authorize a new PR in a disposable repository/project/task, confirm real task/audit/replay behavior and protect historical observations. No DEV-002 or real-rule permission is implied. |
| UI/accessibility                | Historical 12/12 Chromium desktop/mobile results are not a fresh release run. Retain current-release reports/screenshots and verify keyboard/focus, dark/light, loading/error/stale states, authorization and retention/revalidation panels at representative widths/zoom.                                         |
| CI/release evidence             | Retain hosted CI run URL, tested SHA and artifacts; relate earlier PR/squash evidence to the selected release. No CI run or full application test rerun on this rehearsal commit was performed here.                                                                                                               |
| Production supervision          | Open and future deployment-specific. The local bounded supervisor passed; no installed systemd service, production process restart, TLS/egress/capacity or production migration acceptance is established.                                                                                                         |
| Detailed operational cases      | Keep explicit boundaries for bounded/insufficient health, role loss, retention edge/incomplete states and revalidation failure classes. Existing mocked/SQL evidence is separate from live/UI evidence.                                                                                                            |
| Cleanup and evidence durability | No cleanup is authorized. Preserve all four rehearsal runs, retained recovery database and backup. Agree a secure durable evidence location before temporary host storage can expire; copying/deletion needs separately reviewed scope.                                                                            |
| Release decision                | Owner must explicitly accept the isolated subgate and review/defer remaining gates. M3.5 global acceptance is not automatically closed.                                                                                                                                                                            |

No mid-transaction OS kill, post-commit/pre-ack crash, concurrent automation-worker
stress, production systemd recovery, universal native egress denial or exactly-once
execution is claimed. Actual task consistency conclusions are limited to synthetic
fixtures and the implemented assertions. No production deployment exists.

## Recommended handoff

Accept this isolated worker subgate, retain the above open-gate ledger, and review
[the M4 proposal](../docs/M4_IMPLEMENTATION_PROPOSAL.md). Feature work can proceed
after owner approval without treating unfinished production gates as passed or
adding more rehearsal infrastructure by default. Production rollout remains gated.

Proposed documentation-only commit:
`docs: consolidate isolated rehearsal acceptance and propose M4`.
