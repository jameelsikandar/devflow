# DevFlow 2.0 upgrade

Current implementation: M1, M2 and M3.1–M3.4. Current approved work: **M3.5 —
operational acceptance and hardening**, step 2 (durable worker signals).
M3.5 is not complete. The current status and checklist below supersede older
planning statements; dated results remain historical evidence, not fresh passes.

## Current status — M3.5 step 2 (2026-11-15)

The owner created `feat/m3-5-operational-readiness` from `48d7b5c` on clean `main`.
The initial feature-branch check confirmed a clean working tree and empty index.
M1 through M3.4 are accepted as implemented; operational acceptance is recorded
separately. This baseline passed 326 unit tests, schema/client checks, lint, worker
compilation and webpack build. Full/core type and formatting results, exact commands
and connection/browser blockers are recorded in the current VERIFICATION.md section.
All 82 database tests were skipped at connection setup; zero browser tests executed.
Neither result is a pass. No migration, seed, live worker or live external action ran. The
repository-wide format check initially failed on four pre-existing files; the owner
committed the separate formatting-only fix f101e28 after step 1. Step 2 adds worker
signal persistence/classification; scoped API/UI work remains in steps 3–4.

M3.5 reuses the existing queue, workflow executor, task activity and administrator
panels. Approved scope: lightweight PostgreSQL worker health, scoped operational
summaries, explicit caller-authorized connection diagnostics, read-only retention
policy/impact reporting, isolated CI and deployment/acceptance evidence. No Redis,
new task-changing actions, automatic connection changes or M4 work is included.

## Audit — 2026-11-13

This is an incremental upgrade. Existing task, board, authentication, settings,
theme, notification and integration behavior must remain available. The recent
Tasks-list visibility fix and Recharts initial-size fix are existing user changes.

### Verified architecture

- Next.js 16.2.9 App Router / React 19.2.4 / strict TypeScript. Node >=22.12.
- PostgreSQL through Prisma 6.19; one initial SQL migration, an additive seed.
- Custom scrypt passwords and opaque 14-day database sessions. Only token hashes
  are persisted. HTTP-only cookies, Secure in production, SameSite=Lax.
- `requireUser` and `membership` guard APIs; owner/admin role required for invites.
  Exact Origin checks, bounded bodies, Zod input validation, database rate limits.
- Catch-all API implements CRUD, comments, workspace invitations, profiles,
  notifications, snapshots, AI and GitHub. Separate OAuth, avatars and SSE routes.
- Tasks have status, priority, fractional order, due date and optimistic version;
  no start date, estimate, dependency, milestone, sprint or structured status history.
- TanStack Query caches server data; Zustand persists workspace/theme preferences.
  SSE polls durable task activity and presence, refreshing snapshots on changes.
- CSS variable dark/light themes, responsive breakpoints, reduced-motion rules,
  Radix dialogs, common buttons, Lucide icons, dnd-kit board, Recharts analytics.
- Local command palette searches loaded task/project records with keyboard support.
- AI has a server-only OpenAI-compatible text adapter and six read-only prompts;
  missing credentials return 503. No tools, approval records or conversation history.
- GitHub already has OAuth state validation, AES-GCM encrypted tokens, repository
  linking, commit and open-PR reads. No webhooks, issue sync, CI checks or rules.
- Existing analytics uses actual task state/completion dates over seven UTC days;
  no cycle-time history, sprint velocity or historical burndown can be inferred.

### Baseline verification

- Unit tests: **21 passed** in 3 files.
- TypeScript: **failed**. Backup `node_modules.backup-*` is unintentionally included;
  additional avatar Buffer/Prisma typed-array incompatibility in the API route.
- ESLint: traverses backup dependency sources; exclude these before useful full lint.
- Integration suite: **blocked** by missing dedicated `TEST_DATABASE_URL`; its safety
  guard correctly prevents tests against the application database.
- Production build: **failed** in Turbopack CSS processing because this sandbox
  cannot bind a local port (`Operation not permitted`). Try webpack as a fallback.
- E2E: **blocked**; configured development web server fails to start here.
- `pnpm` auto-install also attempts an unwritable store database in this environment;
  installed tools can be executed directly with Node without replacing dependencies.
- `.git` is an empty read-only directory, not a usable Git repository. No commits
  are possible; do not initialize or replace the user's repository metadata.

### Technical debt and missing functionality

- Large catch-all route and workspace view files. Add domain services/new views,
  sharing existing security primitives; avoid rewriting stable modules.
- Unbounded workspace snapshots and local-only search will need pagination/search
  endpoints as data grows. SSE polling is simple but costly at scale.
- Authorization occurs before many transactions; new graph operations must lock
  the project inside the transaction and recheck archive state to avoid write skew.
- No job runner, outbox, retry/lease storage, mail provider, attachment storage,
  CRDT transport, service worker, IndexedDB queue, automated CI, or monitoring.
- Existing documentation includes historical dependency limitations; update reports
  with observed current checks instead of treating old results as current evidence.

## Architecture and implementation order

Keep Next.js, PostgreSQL, Prisma and the design system. Use additive migrations,
small domain services, authenticated endpoints, and explicit input/output types.
No placeholder counters or simulated AI/collaboration will be presented as live data.

### Milestone 1 — roadmap and dependencies (implement first)

- [x] Inspect repository, schema/migration, security, UI, tests and integration code.
- [x] Run baseline checks and record limitations.
- [x] Repair type/lint scope and avatar type error; preserve existing behavior.
- [x] Add nullable task start date, milestone marker and dependency edges.
- [x] Add database constraints, indexes and additive migration.
- [x] Implement self/cross-project/circular dependency validation and project locking.
      Concurrent API test is written; execution requires a test database connection.
- [x] Validate schedule edits, preserve task version conflicts and archive guards.
- [x] Project roadmap API with actual task data and durable activity updates.
- [x] Implement Gantt/timeline, day/week/month zoom, dependency connectors,
      progress, milestones, deadlines, explicit unscheduled states and critical path.
- [x] Implement drag scheduling plus keyboard/date controls; no silent cascading.
- [x] Domain tests and SQL schema tests pass; route/browser regression coverage added.
- [x] TypeScript, ESLint, 38 unit tests and production webpack build passed (latest verification run).
- [x] Harden test database isolation and add a non-resetting preparation command.
- [x] Attempt development migration status, test database preparation, API integration,
      desktop/mobile E2E, development server startup and browser access again.
- [ ] Execute API integration tests, concurrent-write tests and desktop/mobile E2E.
- [ ] Visually verify new timeline/drag behavior in a running browser in both themes.

Latest verification attempt (2026-11-13): TCP connections, PostgreSQL Unix sockets
and HTTP listening return `EPERM`; Docker socket access is denied. Prisma migrate
status returns P1001, so the development migration state is unknown and no application
database migrations were applied here. Test database creation is blocked; a temporary
`devflow_test` URL was used only to attempt the suite. API setup fails before assertions
(13 tests skipped), Playwright fails before either browser project starts, and the
browser host is unavailable. These Milestone 1 gates remain **open**. Milestone 2 proceeded under the subsequent
explicit instruction to defer prohibited infrastructure checks. Exact local recovery
commands are in `VERIFICATION.md`; these checks are not reclassified as passed.

Implementation and detailed verification are recorded in `UPGRADE_REPORT.md`.
Milestone 1 source is implemented; its API/browser release gates remain open.
At this historical M1/M2 checkpoint, Milestones 3–7 were still planned. Current
implementation/status is listed at the top and in the latest M3.5 checklist.

### Milestone 2 — AI project manager

- [x] Structured eight-tool registry with strict validation and scoped queries:
      listProjects/getProject/listTasks/getTask/createTask/updateTask/createSprint/generateReport.
- [x] Sprint/report models, subtask relationships, private conversations, runs,
      durable tool events and actor/workspace-scoped proposals/receipts.
- [x] Immutable full previews, explicit per-action approval/rejection, integrity hashes,
      server-captured versions, expiry, transactional single-use execution and replay.
- [x] Bounded provider tool loop; keys/server configuration never exposed to clients;
      metadata locks, active-run uniqueness and stale/late-result fencing.
- [x] Q&A, briefs, subtasks, sprint planning, current workload/blocker/priority analysis,
      progress summaries and weekly report proposals from authorized records.
- [x] Conversation/activity history, approved artifact views, configuration state and
      existing quick-draft assistant preserved.
- [x] Shared task mutation services preserve board order, validation, version guards,
      activity, labels and assignment notifications for both normal API and AI approval.
- [x] Prisma schema/client checks, 75 unit tests, ESLint, standalone SQL constraint
      suites and webpack production build pass. Full/core TypeScript checked after build.
- [x] New additive migration tested in fresh isolated standalone PostgreSQL; no
      network server, development database reset or blocked connection retry performed.
- [x] Database integration and desktop/mobile UI tests written with explicit provider
      fixtures; sandbox-blocked suites documented without marking them passed.
- [ ] Run real PostgreSQL API/concurrent approval/rollback and browser suites locally.
- [ ] Validate a configured live provider and visually review approval/history UI.

**Milestone 2 implementation is complete with available checks passing.** Live
provider, database-backed integration/concurrency and browser gates remain open.
Details: `AI_PROJECT_MANAGER.md`, `UPGRADE_REPORT.md`, `VERIFICATION.md`.
At this historical M2 checkpoint, Milestone 3 had not started. M3.1–M3.4
are now implemented; M3.5 baseline work is the current approved scope.

### Milestone 3 — GitHub and durable automation

The original broad mission is reconciled here with the implemented M3.1–M3.4
scope. Checked items indicate source implementation, not a claim that all live
operational gates passed in this environment.

- [x] Bounded raw-body signature verification, repository identity checks and unique
      delivery receipts.
- [x] PostgreSQL delivery queue and durable workflow execution stage with lease
      fencing, bounded retries, idempotent effects, history and a worker command.
- [x] Project/workspace-scoped DEV references and GitHub object/task evidence.
- [x] Commit/PR/issue/workflow-run facts; four configurable PR status rules;
      encrypted server-only connector credentials.
- [x] Administrator enable/disable, rule revisions, read-only previews and
      automation outcomes in the existing interface.
- [x] Signature, replay, concurrency, authorization and rollback regression suites.
- [ ] M3.5 operational health, explicit diagnostics, read-only retention reporting,
      CI and recorded database/browser/live acceptance evidence.

A generic trigger/condition/action builder, email actions, additional mutations and
GitHub App migration are deferred scope. They are not prerequisites silently added
to the approved M3.5 operational milestone.

### Milestone 4 — collaborative documentation

- [ ] Yjs/editor dependency and authenticated WebSocket transport; durable binary
      updates, snapshots and compaction. Do not use last-write-wins text autosave.
- [ ] Document/project/member ACLs, rich text/Markdown, presence/cursors, comments,
      autosave, version history and restore-as-new-version.
- [ ] Concurrent update merge/persistence and ACL/revocation integration tests.

### Milestone 5 — engineering analytics

- [ ] Structured status transitions, sprint baselines and estimates captured at write.
- [ ] Date/project filters, velocity, burndown, cycle/lead time, workload, overdue
      percentage, health, trends/activity and bottlenecks; CSV export.
- [ ] Define denominators, time windows, UTC boundaries and insufficient-data states.
      Never fabricate historical metrics for pre-upgrade tasks.

### Milestone 6 — communication and search

- [ ] Channels, membership-restricted DMs, threads, mentions, reactions, reads,
      unread counts, bounded attachments and authenticated real-time delivery.
- [ ] PostgreSQL full-text indexes and ranked authorized global search across tasks,
      projects, documents, people and comments; debounced accessible command palette.
- [ ] Cross-conversation/document/workspace isolation tests.

### Milestone 7 — offline, polish and release gates

- [ ] PWA manifest/service worker for static shell; opt-in scoped project cache.
- [ ] IndexedDB edits with actor/workspace/version keys; authenticated replay,
      conflict resolution, sync indicator, logout/account-switch data cleanup.
- [ ] Never service-worker-cache auth/session/credential responses indiscriminately.
- [ ] Unified dark/light UI, keyboard navigation, onboarding/settings, loading,
      empty/error states, responsive and reduced-motion/accessibility verification.
- [ ] Full verification matrix, configuration examples and feature/limitations report.

## Migration strategy

1. Add task scheduling columns with nullable/default values; old tasks stay unscheduled.
   Add task dependency edges with composite project/task foreign keys, uniqueness,
   self-edge checks and a serialized graph write path. Do not change task numbers.
2. Add sprint, sprint membership/baseline, report and AI run/proposal records.
3. Add integration events, webhook deliveries, workflow definitions/executions/jobs.
4. Add document ACLs, Yjs update/version stores and document comments.
5. Add typed task transitions for forward-looking analytics, then conversations,
   attachment metadata/read positions and full-text indexes.

Apply migrations to a separate test database first. Production changes require a
backup and normal release migration process. Client generation is necessary after
schema updates. Do not run schema reset/db push on existing application data.

## External configuration and release limitations

PostgreSQL is required for API/integration verification. A separate database ending
in `_test` is mandatory for integration tests. GitHub requires OAuth app credentials,
token encryption key, webhook secret and reachable HTTPS callback. AI requires a
server API key/base URL/model. Collaborative transport, job workers, email and file
storage require deployment decisions/configuration; unimplemented portions above
remain unchecked until they are implemented and verified.

### Focused Milestone 2 follow-up — AI chat UX (2026-11-13)

- [x] Inspect architecture, stored/returned answers, chat/history, tool audit,
      proposals, design tokens and existing dependencies.
- [x] Safe GFM token-to-React rendering, responsive tables/checklists, copyable
      highlighted JS/TS/JSON code and response copy controls.
- [x] Authorized task-reference navigation, readable fields, compact collapsible
      tool activity with redacted developer diagnostics.
- [x] Server-resolved personal/all/unassigned read scopes and friendly context;
      preserve provider transport, auth, audit and all approval execution safeguards.
- [x] Chat spacing/composer/shortcuts, real loading/error states and reader-aware
      scrolling. Quick Drafts behavior unchanged.
- [x] Mounted interaction/security/regression tests; 99 unit/DOM tests pass.
- [x] TypeScript full/core, ESLint, Prisma generation and webpack build pass.
- [x] Format changed source; retain unrelated existing formatting differences.
- [x] Extend database and desktop/mobile browser fixtures; document actual execution
      limits and local commands in `AI_CHAT_UX.md` and `VERIFICATION.md`.
- [ ] Execute the 22 real-database tests and four browser cases outside the sandbox;
      inspect desktop/mobile layout, contrast, clipboard and live Groq response quality.

No schema migration, primary-key change, new endpoint, provider change or Milestone 3
work is included in this follow-up. New dependencies and the cached-tokenizer choice
are documented in `AI_CHAT_UX.md`. Passing DOM tests do not close browser/API gates.

### Focused Assistant retrieval/context follow-up — 2026-11-13

- [x] Trace actor/auth, project/workspace scope, assignee/archive filters, pagination,
      model instructions, serialized results and UI defaults. No reliable creator field.
- [x] Preserve strict assigned-only reads; add opt-in, bounded project-only contextual
      reads, unfinished filtering, accurate pagination and explicit creator limitation.
- [x] Forward the shell project to new drafts; show immutable real conversation scope,
      hold unknown/archive composer states and expose explicit new-scope/task actions.
- [x] Audit/refine the entire Assistant page, scoped plans/reports and Quick Drafts;
      reset draft state on workspace changes. Preserve approvals/provider/security.
- [x] 118 unit/DOM tests pass; full/core types, lint, Prisma generation and webpack build
      pass. Changed-file formatting passes; unrelated baseline differences retained.
- [x] Extend/discover DB/browser regression coverage; document exact blockers/results.
- [ ] Execute 23 real-database tests and six browser cases externally, inspect the real
      page/screenshots at desktop/tablet/mobile widths and verify live Groq compliance.

No new dependency, migration or endpoint. Milestone 3 remains not started.

### Assistant workspace / provider stabilization — 2026-11-13

- [x] Audit shell and three conflicting layout sources before editing; replace height/
      overflow overrides with inherited viewport workspace bounds and distinct CSS roles.
- [x] Compact header/composer, wider clamped history, focus-managed history dialog,
      secondary report pane and preserved conversation state across Quick Drafts.
- [x] Dedicated 429/timing/backoff handling, no implicit retries, partial-result UI,
      full audit preservation and compact model-facing records.
- [x] 144 available tests pass; types, lint, Prisma generation and webpack build pass.
- [x] Document actual results; discover 24 DB tests and six browser cases.
- [ ] Execute real DB/browser suites, inspect supplied/actual screenshots and live Groq.

Visual acceptance is incomplete; no browser host or screenshot files available.
No schema/dependency additions, destructive DB work or Milestone 3.

### Agent reasoning/provider-efficiency follow-up — 2026-11-13

- [x] Audit clarification instructions and independent tool dispatch; preserve page layout.
- [x] Authorized project catalog/default/name resolution; narrow zero-provider task reads.
- [x] Run-local, reauthorized equivalent-read reuse and explicit fresh-read support.
- [x] Condensed context/history and opt-in sanitized usage/rate diagnostics.
- [x] Scope/completeness wording for verified records; preserve approvals and audit.
- [x] 172 available tests/types/lint/webpack checks pass; update actual result docs.
- [ ] Execute 25 database tests and six browser cases outside the restricted environment;
      verify live Groq quota/header evidence for complex requests.

No stylesheet/page redesign, migration/dependency, DB reset or Milestone 3.

## Milestone 3 execution plan — 2026-11-13

The latest user-run verification reports 25/25 PostgreSQL integration tests and all
four AI desktop/mobile cases passing. Two roadmap E2E assertions were repaired and
manually accepted by the user; live Groq acceptance remains pending. Earlier counts
above are historical. That checkpoint authorized M3.1 only; the current approved
M3.5 scope is recorded at the top and in the checklist below.

### M3.1 — repository connections and durable webhook inbox (implemented; historical plan)

- Reuse existing per-user OAuth/encrypted credentials and GitHub repository picker.
- Require workspace owner/admin AND a fresh GitHub `permissions.admin` check to
  connect; store canonical repository ID/name and composite workspace/project scope.
- Use manual repository-webhook setup with a server-generated per-connection secret,
  encrypted at rest and disclosed once. OAuth does not create/manage webhooks.
  GitHub App installation is deferred: it would need new installation permissions,
  signing keys, reconciliation and revocation handling beyond this foundation.
- Strict raw-byte HMAC SHA-256, bounded bodies, repository ID/event allowlist checks;
  unique delivery receipts, payload digest checks, minimal normalized event fields.
- Persist accepted events transactionally as PENDING before acknowledging them;
  preserve receipts and cancel pending work on soft disconnect. No worker/task writes.
- Add migration, management/setup UI, authorized endpoints, unit and isolated real-DB
  tests; run available checks and document external setup/runtime gates.

### M3.2 — activity and task association (implemented; runtime gates open)

Read authorized inbox records through a bounded worker; fetch current GitHub facts,
track commits/PRs/issues/CI, resolve valid task references without changing tasks.
Verify processing leases, retries, redelivery and reconnect boundaries independently.

### M3.3 — workflow definitions and previews (implemented; runtime gates open)

Administrator-only project rule settings; four verified PR triggers, target status,
connection scope, explicit enable/disable and numeric priority. Versioned revisions,
request receipts and optimistic edits. Evaluate actual observation-specific evidence
without task writes. The latest M3.3 checklist below records verification gates.

### M3.4 — safe GitHub status execution (implemented; runtime gates open)

Durable evaluations and a second SQL-only stage in the existing worker; confirmed
version-bound activation, historical-delivery fencing, fresh authorization/source/rule
checks, optimistic task writes, atomic machine-attributed activity, bounded retries
and execution monitoring. No email or unrelated workflow actions were added.

### M3.5 — operational acceptance (in progress; step 2 prepared)

Approved: establish baseline evidence, extend PostgreSQL worker-health visibility,
reuse administrator summaries/history panels, add explicit authorized connection
revalidation and read-only retention reports, introduce isolated CI, and record
operational/browser/live acceptance. Health must distinguish idle, unavailable,
bounded runs and insufficient evidence. Retention never deletes or archives records.
The owner performs each local commit and confirms it before the next logical step.

M3.1 checklist (update after verification):

- [x] Connection persistence, permissions and setup/disconnect flow.
- [x] Authenticated, minimized, replay-safe durable webhook inbox.
- [x] Additive schema migration and configuration documentation.
- [x] Unit/type/lint/build checks; real-DB tests executed or explicitly blocked.

M3.1 available verification: 206 unit/DOM tests pass in 20 files; Prisma generation
and validation, full/core TypeScript, ESLint, changed-file formatting and webpack
build pass. The isolated DB attempt fails its initial connections: 34 tests skipped
across three setup failures. Nine new GitHub integration cases are written, not
executed. Live GitHub setup and browser acceptance remain open; no migration was
applied to an application database. At that historical M3.1 checkpoint, later
phases had not started; current implementation/status is summarized above.

## M3.2 implementation — 2026-11-14

M3.1 is manually verified by the user: real ping/push accepted and stored PENDING.
The following processing phases are implemented; runtime gates remain distinct.

- [x] **M3.2a** Additive lease/dead-letter/version fields, explicit enrichment grants,
      scoped GitHub object/observation/task-link/evidence models, FK/uniqueness/indexes.
      Legacy compatibility and migration-contract tests pass; Prisma validation/generation
      pass. Test migration was explicitly targeted to `devflow_test` but failed P1001.
- [x] **M3.2b** PostgreSQL SKIP LOCKED claiming; leased/renewed/fenced publication;
      recovery and exhausted-attempt terminalization; backoff/jitter/provider waits;
      bounded continuous/once worker, graceful draining, sanitized logs, compiled entry
      point and opt-in systemd deployment example. Runtime/config tests pass.
- [x] **M3.2c** Ping/push/PR/issue/workflow handlers, bulk idempotent publication,
      immutable signed/API observation provenance, timestamp-monotonic projections,
      authorized DEV references and association evidence. No task writes or fake humans.
- [x] **M3.2d** Typed bounded GitHub transport, fixed paths/no redirects, explicit
      caller-owned OAuth authorization, identity checks before/after fetch, credential/
      membership/grant fencing, bounded compare pagination and persistent cooldown.
      Mocked transport/authorization tests pass; no live enrichment tested.
- [x] **M3.2e** Authorized status/filter/count/pagination endpoints and existing-page
      panel, object/task navigation, strict admin retry and enrichment controls. Unit/DOM
      controls pass. Human audits are limited to explicit user actions.
- [ ] Execute the additive migration and all PostgreSQL transactional/concurrency
      assertions on the isolated `devflow_test` outside the sandbox.
- [ ] Verify the real compiled worker drains the user's existing pending ping/push,
      then live authorized enrichment and supervised deployment/shutdown.
- [ ] Execute browser regressions and inspect desktop/mobile processing controls.

Phase gates during implementation: A targeted 21 tests passed; B 9; C 10; D fixture
failure was corrected (mock one-off response state was leaking between cases), and
all transport/enrichment cases passed; E targeted 15 tests plus 2 GitHub DOM cases
passed. A workflow-reference test exposed a missing assignment and was corrected.
Final whole-suite counts and final build/type/lint results are in VERIFICATION.md.
No failed check is reclassified as successful. Database/browser restrictions prevent
closing runtime gates. At that M3.2 checkpoint, M3.3–M3.5 were unimplemented;
the current status is recorded above.

Final M3.2 available gates: 239 unit/DOM tests in 27 files, Prisma validation/client
generation, full/core TypeScript, worker compilation, ESLint, changed-file formatting
and webpack pass. Isolated migration is P1001-blocked; 47 database cases skipped at
four setup failures; no browser cases executed (EPERM). No application migration or
existing pending-event processing was performed by the agent. Manual acceptance
instructions are in GITHUB_INTEGRATION.md and VERIFICATION.md.

### M3.2 follow-up — padded DEV references and targeted recovery

- [x] Trace leading-zero rejection at extraction/validation/lookup; canonicalize padded
      aliases without renumbering tasks or broadening project/workspace authorization.
- [x] Exact-message regression and explicit own-grant GitHub API reconciliation for an
      existing processed commit; preserve observations/receipts and idempotent evidence.
- [x] 248 unit tests, types/lint/worker/webpack/format checks pass.
- [ ] Execute the 49 isolated DB tests and reconcile the live 9023d37 commit locally.

No M3.3/M3.4 work or application DB changes. See the latest GITHUB_INTEGRATION.md and
VERIFICATION.md sections; PostgreSQL setup remains blocked inside this sandbox.

### M3.2 follow-up — task GitHub activity visibility

- [x] Reuse stored associations through independently scoped, authenticated read APIs.
- [x] Add the existing task-dialog GitHub section, safe object links/status/history,
      loading/empty/error/pagination states and passive card count; preserve DnD/editor.
- [x] Nine new service/DOM tests; 257 total pass. Types/lint/worker/webpack/format pass.
- [ ] Execute 52 real-DB tests and eight desktop/mobile cases outside the sandbox;
      inspect actual task-dialog screenshots and the user's existing DEV-002 association.

No schema/dependency changes, application DB writes or M3.3/M3.4. Full execution
results and local navigation steps are in VERIFICATION.md and GITHUB_INTEGRATION.md.

### M3.3 — definitions and safe previews (2026-11-15)

- [x] Audit existing project cards, role authorization, project lock order, normalized
      PR observations, enrichment provenance and task-link evidence.
- [x] Add disabled-by-default rules and append-only API audit revisions through the
      additive `202611150001_github_workflow_definitions` migration. Preserve M3.1/M3.2.
- [x] Administrator-only CRUD/read/history/preview endpoints; strict validation,
      project-first serialization, expected-version checks and idempotent requests.
- [x] Project card → Workflow rules dialog: edit, enable/disable, soft-delete, priority,
      repository scope, paginated PR observation selection and configuration history.
- [x] Pure evaluator: four PR triggers, explicit disabled-rule simulation, real task
      evidence and current status/version snapshots; explain stale/duplicate/ambiguous,
      missing/incomplete/disconnected and conflicting-rule cases.
- [x] Available unit/DOM, full/core types, lint, worker build, schema validation,
      Prisma generation and webpack checks. Exact results: latest VERIFICATION.md.
- [ ] Apply migration and execute 61 PostgreSQL tests on isolated `devflow_test`.
      This sandbox cannot reach localhost:5433; all 61 skipped, zero passed.
- [ ] Run desktop/mobile Playwright and inspect actual screenshots. The webserver
      failed to start here, so browser assertions and visual acceptance remain open.
- [ ] After local checks, manually deploy the additive application migration and
      preview an actual stored PR event. No application migration was applied here.

M3.3 adds no worker hook, execution receipt, automatic action, task mutation,
GitHub request or runtime dependency. At that historical M3.3 checkpoint,
M3.4/M3.5 were unimplemented; current status is recorded above.

### M3.4 — implementation checklist (2026-11-15)

- [x] M3.4a: additive execution-state/model migration, provenance/scope FKs,
      observation and semantic-event uniqueness, immutable evaluation snapshots,
      rule activation/version grants, explicit machine activity source.
- [x] M3.4b: extract the M3.3 database read evaluator for preview/worker reuse;
      require matching enabled rules, confirmed version, fresh source/receipt time,
      administrator authorization and complete unambiguous observation evidence.
- [x] M3.4c: project→connection→delivery→execution→task locks, task version CAS,
      shared existing completion-date semantics, atomic task/audit/activity commit.
- [x] M3.4d: enqueue alongside fenced GitHub publication; existing worker drains
      durable pending executions. SQL transaction locks recover on crashes; bounded
      transient backoff, permanent terminal outcomes, no external calls in action TX.
- [x] M3.4e/f: confirmation before enabling/editing enabled rules, explicit legacy
      preview-only state, execution filter/pagination, source PR/task inspection,
      machine activity in existing detail/feed UI. Existing Kanban refresh is reused.
- [x] M3.4g: unit/DOM, PostgreSQL concurrency/crash/security cases and desktop/mobile
      browser regression journey added. Available static/unit/build checks passed.
- [x] M3.4h: migration/deployment/worker/retry/security documentation and new-PR
      live acceptance procedure in GITHUB_INTEGRATION.md; exact local commands in
      VERIFICATION.md. No live rule enabled, PR merged or application DB changed here.
- [ ] Execute all 82 PostgreSQL cases locally; all skipped here at connection setup.
- [ ] Execute 12 Playwright cases and inspect desktop/mobile screenshots; EPERM
      prevented the isolated server/browser run here. Discovery is not acceptance.
- [ ] Manually apply application migration after isolated tests; confirm a rule,
      merge a NEW test PR referencing DEV-002, inspect one status/activity update,
      redelivery idempotency and historical PR #1 remaining unexecuted.

M3.4 implementation is present; real-DB, browser and live GitHub acceptance remain
open. M3.5 was outside that M3.4 checkpoint; its separately approved scope
follows below. Unrelated actions/automation triggers remain excluded.

## M3.5 approved sequence and acceptance gates — 2026-11-15

Step 1 documentation (f1a1a2b) and formatting cleanup (f101e28) were confirmed by
the owner before step 2 began. Step 2 is prepared for the owner's local commit.
**Do not begin step 3 until the owner confirms step 2 was committed.**

| Step | Focused commit                                                    | State                                                                |
| ---- | ----------------------------------------------------------------- | -------------------------------------------------------------------- |
| 1    | docs: reconcile milestone status and operational acceptance gates | Committed: f1a1a2b                                                   |
| 2    | feat(ops): persist scoped worker health signals                   | Implementation prepared; DB acceptance blocked; owner commit pending |
| 3    | feat(github): expose authorized operational health summaries      | Pending                                                              |
| 4    | feat(github): display operational health in existing panels       | Pending                                                              |
| 5    | feat(github): add explicit connection revalidation diagnostics    | Pending                                                              |
| 6    | feat(ops): add read-only retention impact reports                 | Pending                                                              |
| 7    | test: cover operational failure and recovery journeys             | Pending                                                              |
| 8    | chore: add isolated CI verification                               | Pending                                                              |
| 9    | docs: publish M3.5 deployment and acceptance runbooks             | Pending                                                              |

Relevant tests accompany each functional step; discovered defects get their own
focused fix commits rather than being hidden in unrelated changes. No reset,
amend, rebase, push or merge is authorized. Only the owner stages/commits locally.

- [x] Confirm correct feature branch, clean starting tree and baseline commit.
- [x] Run available baseline checks and record blocked DB/browser tests accurately.
- [x] Reconcile current scope versus historical records and deferred feature scope.
- [x] Owner confirmed step 1 commit f1a1a2b before further implementation.
- [x] Resolve the four recorded baseline formatting violations in a separate
      `chore: normalize baseline source formatting` change (f101e28); checks rerun.
- [x] Implement worker signal persistence/classification without misleading idle/bounded/unknown alerts (step 2 source; PostgreSQL acceptance pending).
- [ ] Add authorized summaries and diagnostics without silently mutating connections.
- [ ] Add retention policy/dependency impact reporting without deletion or archival.
- [ ] Add isolated CI and operational failure/recovery coverage; preserve replay,
      idempotency, authorization, task-version and lease-fencing guarantees.
- [ ] Obtain actual passing isolated PostgreSQL and desktop/mobile browser evidence.
- [ ] Obtain separately authorized owner-run live evidence for new-event execution,
      redelivery, restart and connection lifecycle behavior in disposable test scope.
- [ ] Record deployment/runbook evidence and remaining limits before closing M3.5.

M3.5 cannot be marked complete while required live acceptance gates are unperformed.
DEV-002, live rules/connections and production records remain untouched. Existing
M3.4 live instructions are an owner-run procedure, not permission for the agent to
create webhooks, enable a rule, revoke credentials or merge a real PR.

### Step 2 evidence — durable worker health

The owner confirmed f101e28 and the feature branch/tree was clean before this
change. Prepared commit: `feat(ops): persist scoped worker health signals`.
New additive migration 202611150003_github_worker_health creates only operational
signal storage/enums; no existing rows are rewritten. Signals are scoped to a run
and repository connection, with composite project/workspace foreign keys. Heartbeat,
queue polling, attempt progress and bounded/continuous lifecycle are distinct.
No API or UI is added until steps 3–4. Classifier results are evidence summaries,
not deployment alerts or proof of successful task execution.

Full/core TypeScript, worker compilation, Prisma validation/generation and a
schema-to-schema migration diff are verified without database writes. The new
PostgreSQL cases require owner-local execution: a guarded devflow_test connection
probe failed at localhost:5433; no migration or test database writes were attempted.
See VERIFICATION.md for final unit/build/format results and safe local commands.
The migration has not been applied to either database here.

**Stop for owner commit confirmation before step 3.** M3.5 live acceptance remains
open; no live worker, rule, repository connection or DEV-002 was changed.
