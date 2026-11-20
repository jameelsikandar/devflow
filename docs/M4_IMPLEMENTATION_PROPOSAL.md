# M4 proposal — project documentation and live collaboration

**Proposal only; implementation is not authorized or started.** This follows the
[existing M4 roadmap](../UPGRADE_PLAN.md#milestone-4--collaborative-documentation),
not a new GitHub automation milestone. The
[isolated M3.5 rehearsal report](../deploy/M3_5_ISOLATED_REHEARSAL_REPORT.md) records
its passed subgate and separately outstanding release/production requirements.

## Current implementation and dependencies

- Next.js App Router, Prisma/PostgreSQL, opaque database sessions and workspace
  OWNER/ADMIN/MEMBER roles already exist. Reuse session validation, membership,
  project scoping, request validation and established transaction conventions.
- Current Prisma schema has no collaborative document, document ACL, Yjs update,
  version or document-comment models. Additive migrations are required.
- Existing `src/app/api/events/route.ts` provides polling SSE for task activity and
  presence. It revalidates sessions/membership but is not a bidirectional CRDT
  transport. Do not overload it or the GitHub worker with editing traffic.
- Existing safe Markdown rendering and typography/design tokens can inform the
  reader/editor UI. They are not an existing collaborative editor. Current package
  dependencies contain no Yjs/editor/WebSocket integration.
- A narrowly scoped Yjs-compatible editor and authenticated WebSocket endpoint
  are necessary architectural additions. Propose one small Node collaboration
  process sharing PostgreSQL and existing session semantics, not Redis, a queue or
  a hosted collaboration service. Owner approval of that process/dependency choice
  is required before implementation. Pin compatible versions after a focused spike;
  this proposal does not claim package compatibility testing.

## Priorities and focused implementation commits

| Phase / proposed commit                                                | Scope                                                                                                                                                                                                                                                                     | Acceptance criteria                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M4.1 — `feat(docs): add scoped document metadata and permissions`      | Approve transport/editor design; add project/workspace-owned document metadata, explicit reader/editor grants and audit fields. Implement paginated list/create/rename and permission APIs with additive migrations. Define admin override and archived-project behavior. | Cross-workspace/project foreign keys and server authorization prevent ID substitution. Reader cannot edit. Metadata version conflicts are explicit. No task, GitHub rule or existing data changes. No placeholder last-write-wins document-body persistence.                                                |
| M4.2 — `feat(docs): persist authorized collaborative edits`            | Small authenticated WebSocket transport; durable Yjs binary updates, update identifiers/sequence and reconnect/state-vector catch-up. Rich-text editor, Markdown import/export and clear autosave status.                                                                 | Two browsers merge simultaneous edits without overwrite; edits acknowledged as saved survive restart. Duplicate/resend is idempotent. Limits reject oversized/invalid updates. Logout, expiry, role loss and document ACL changes prevent further unauthorized writes and close unauthorized subscriptions. |
| M4.3 — `feat(docs): show collaboration presence and comments`          | Ephemeral authorized presence/cursors; document comment threads anchored to collaborative content; resolve/reopen interactions.                                                                                                                                           | Presence has bounded expiry and is not durable document content. No unauthorized identity/content leakage. Concurrent edits preserve comment anchors or expose an explicit orphaned-anchor state. Presence never reports an unsaved edit as persisted.                                                      |
| M4.4 — `feat(docs): add version history and safe restore`              | Durable snapshots/version history, attributed edits and restore-as-new-version. Initially use non-destructive snapshots; define any later update deletion separately.                                                                                                     | Snapshot/update boundary is atomic. Reconnect across snapshots loses no acknowledged update. Restore retains prior history, rechecks authorization and coordinates connected editors rather than allowing stale clients to silently undo it.                                                                |
| M4.5 — `test(docs): verify collaboration and responsive workflows`     | Project-integrated document list/editor, empty/error/reconnecting states, keyboard/focus and responsive dark/light polish; end-to-end and compatibility verification. Include tests with each earlier functional commit too.                                              | Two-user desktop/mobile tests demonstrate persistence, concurrent merging, permission revocation, comments and history. Existing tasks, Board, roadmap, AI approval, GitHub links and automation tests retain behavior. Report actual pass/fail/skip counts.                                                |
| M4 handoff — `docs: document collaboration deployment and limitations` | Configuration examples, migration/startup order, single-process constraint, recovery/backup boundaries, metric-free acceptance report.                                                                                                                                    | Clear local setup with no secrets; actual verification evidence separated from production deployment and unexecuted checks.                                                                                                                                                                                 |

Each phase should leave a reviewable working state and receive relevant checks
before its own commit. Do not combine unrelated changes. Create a dedicated
`feat/m4-collaborative-documents` branch from the owner-selected reviewed base;
do not create it, push or merge as part of this proposal.

## Data integrity and security decisions to settle in M4.1

1. Use scoped `Document`, `DocumentGrant`, `DocumentUpdate`, `DocumentVersion` and
   comment/thread records with composite scope constraints and bounded indexes.
   Reuse existing users/projects; do not invent authorship for historical data.
2. Preserve existing HttpOnly session semantics. A standalone WebSocket upgrade
   cannot directly call Next.js `cookies()` helpers; share a small server-side
   session-validation primitive if needed, rather than implementing another login
   system. Check Origin before loading content; never put bearer secrets in URLs.
3. Recheck authorization for writes inside the persistence transaction, with a
   documented lock order shared by ACL changes. Revalidate connected readers and
   close revoked sessions; specify and test the revocation bound. Broadcasting
   unauthorized documents is a defect even if writes are blocked.
4. Publish persisted updates as saved only after commit. Define transient failure,
   backpressure, duplicate update and reconnect semantics. PostgreSQL is the durable
   source; in-memory room state is not sufficient.
5. Initially support one collaboration process explicitly. Multi-instance fanout
   and failover are not silently supported; reject unsupported deployment topology
   or implement/test PostgreSQL catch-up before claiming that support. Final
   enforcement mechanism is an owner-reviewed M4.1 design decision.
6. Treat imported Markdown, editor content, links and comments as untrusted. Keep
   safe protocols, no raw HTML execution, bounded message sizes and resource usage.
   Do not add arbitrary attachment fetching or external URL enrichment.

## Testing and verification strategy

- Pure/unit/DOM: authorization policy, validation, update identifiers, safe content
  rendering, autosave/reconnect states, keyboard controls and permission UI.
- Real isolated PostgreSQL (`devflow_test` only, after execution authorization):
  migration compatibility, scope constraints, concurrent writes, duplicate updates,
  atomic snapshots, permission-change races and restore history. Never reset or
  migrate the application database automatically.
- Local two-client integration: connect/reconnect, process interruption, persisted
  state rehydration, session expiry/revocation and absence of cross-document leaks.
  Use a test-scoped collaboration process, not retained rehearsal resources.
- Playwright: separate authenticated browser contexts, overlapping edits, refresh
  persistence, reader denial, comments/restore and desktop/mobile responsive focus.
  Screenshots must follow actual rendered inspection.
- Run full/core TypeScript, lint, changed-file formatting, relevant unit/integration
  tests, worker compilation and webpack build; run existing API/AI/GitHub/roadmap
  regressions and isolated CI. Discovering tests is not executing them.

No new tests, builds, package installs, servers or database operations were run to
prepare this proposal. Existing M3.5 results are not evidence for unbuilt M4 code.

## Scope boundaries and owner decision

No new AI features, analytics milestone, chat system, global search, PWA/offline-first
support, attachments platform or GitHub automation action is included. Reconnect
support is required; full offline-first behavior remains the later roadmap item.
Existing GitHub worker/rehearsal architecture and all application data stay intact.

Recommended next approval: M4.1 design and scoped document foundations, with the
small WebSocket process/editor dependencies explicitly approved first. Then deliver
the first usable collaborative editor in M4.2 before expanding comments/history.
Keep M3.5 key custody, rollback, real GitHub, detailed UI, CI/release and production
supervision gates tracked; planning M4 does not waive them or close M3.5 globally.
