# DevFlow 2.0 — implementation report

## Scope delivered

The audit, roadmap/dependency implementation (Milestone 1), and agentic AI project
manager (Milestone 2) are implemented. Milestone 3 includes M3.1 connections,
M3.2 event processing, M3.3 workflow definitions/dry-run previews, and M3.4
confirmed future-event status automation. Database/browser/live automation acceptance
remains open in this sandbox. M3.5 step 2 adds durable worker signals and evidence classification; step 3 now
provides administrator-only operational summary APIs. Step 4 prepares their
display in the existing processing panel (committed e3f6ecf). Step 5 adds explicit
connection diagnostics (committed 09a32aa). Step 6 adds read-only retention reports;
later operational work remains pending. Step 2 migration verification remains unavailable in this sandbox.
This is **not a claim that the entire DevFlow 2.0 mission is finished**. The checklist
in `UPGRADE_PLAN.md` records the remaining phases and open release gates.

### Implemented

- Audited the repository structure, configuration, PostgreSQL schema and migration,
  sessions/authorization, route handlers, integration adapters, frontend state,
  components, design tokens, seed, and automated test suites.
- Added Roadmap navigation and a command-palette action without replacing existing
  board, Tasks list, projects, settings, analytics, AI or GitHub screens.
- Gantt layout and chronological Timeline layout use actual project/task/dependency
  records. Day/week/month scales, period navigation, Today, progress, milestone
  diamonds, dependency connectors, unscheduled states and deadline counts are present.
- Date editing and dnd-kit pointer/keyboard drag scheduling persist through existing
  versioned task PATCH operations. Both dates move together, preserving duration.
  Errors refresh state and show a toast; stale versions return 409.
- Milestones are task records marked `isMilestone`, with dates on one UTC day.
  They retain normal task details, status, comments, assignee and activity.
- Dependency creation/removal validates membership, active project, both endpoints,
  self-links and graph acyclicity. Project row locks serialize graph changes under
  READ COMMITTED. Duplicate creates/deletes are idempotent.
- Task creation, edits, comments and deletion also lock/recheck the project inside
  their write transaction, preventing races with archive/dependency mutations.
- Database constraints reject reversed date intervals, invalid milestone dates,
  self-edges, duplicate edges and cross-project edges. Task deletion cascades edges.
- Read-only archived roadmaps; changes flow through the existing activity/SSE system.
- Calendar-day critical path and per-task slack derive from actual scheduled
  durations. No duration is inferred for incomplete schedules. Scheduling conflicts
  are displayed; dependent tasks are never moved implicitly.
- Repaired baseline type/lint failures: exclude backup dependencies/generated files
  from lint, exclude backup dependencies from TypeScript, copy avatar data to a
  Prisma-compatible `Uint8Array`. Existing Tasks/chart fixes remain intact.
- Added an optional `build:webpack` script, test database configuration example,
  roadmap setup/API documentation and meaningful automated regression coverage.

## Milestone 2 — agentic AI implementation

- Added secure structured tool calling for exactly eight project/task/sprint/report
  tools. Project-scoped conversations cannot escape their project; all tools recheck
  workspace membership and use bounded explicit public data selections.
- Added private persistent conversations, idempotent turns, tool events, proposals,
  approval receipts, approved sprint baselines and project reports. Existing quick
  drafts and the legacy six-action assistant endpoint remain available.
- AI-generated task creation/updates, child tasks, sprint saves and report saves are
  **proposals only** until an explicit user decision. The model has no executor,
  approval, deletion, membership, environment or arbitrary network/query tool.
- Full before/after previews are immutable and digest-bound. Approval accepts only
  a decision and matching preview hash, then rechecks ownership/membership, expiry,
  project/related records and captured task versions. Domain writes and durable
  receipts commit in one transaction; repeat approvals replay the receipt.
- Conversation locks, request-key uniqueness, a SQL partial unique RUNNING index,
  run leases and completion fences protect concurrent/idempotent requests. Approval
  row/project locks serialize domain changes. Live concurrency remains an integration
  release gate, not something inferred from mocked unit tests.
- The UI includes scoped chat/history, task briefs/subtask/sprint/report templates,
  human review/approve/reject controls, tool activity and approved artifact views.
  It shows a setup state when credentials are missing and never fabricates responses.
- Extracted shared task services from the existing API so both paths preserve task
  validation, date checks, labels, board ordering, activity, notifications and stale
  versions. Parent/subtask context is visible in the normal task dialog.
- Reports attach actual snapshot metrics with explicit period/asOf definitions.
  Workload is unfinished task counts, not measured capacity or velocity. Historical
  transitions are not invented, and AI-written narratives require human review.
- Provider traffic is bounded, timed out and server-only; redirects are refused and
  provider errors are sanitized. No live provider call was made during development.

See [AI_PROJECT_MANAGER.md](AI_PROJECT_MANAGER.md) for the API contract, security
boundaries, budgets, metric definitions, history limits and configuration.

## Milestone 2 — verification results

| Check                                        | Actual result                                                                                                                                 |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Prisma schema validation / client generation | Passed with Prisma 6.19                                                                                                                       |
| Unit tests                                   | **75 passed across 10 files**; 37 new tests beyond the previous 38                                                                            |
| Full/core TypeScript                         | Passed when run after Next completed regenerating its types                                                                                   |
| ESLint / changed-file formatting             | Passed                                                                                                                                        |
| SQL migrations / constraints                 | All three committed migrations and all three SQL suites passed in a fresh isolated PostgreSQL 18.6 standalone cluster; no ERROR/FATAL entries |
| Production webpack build                     | Passed compilation, TypeScript, prerendering and build traces                                                                                 |
| Database-backed API / concurrency tests      | Written but **not run** in this milestone; established TCP/Unix socket EPERM restriction was not retried                                      |
| Browser / visual tests                       | Written but **not run**; established HTTP-listen EPERM/browser-host restriction was not retried                                               |
| Live AI provider                             | Not tested; requires configured credentials, connectivity and tool-compatible provider                                                        |
| Development migration application            | Not performed; application database and .env credentials were not modified                                                                    |

The 37 added unit tests cover strict registry/input validation, protocol sequencing,
read-vs-preview separation, unknown/injected tools, tool/context/proposal/time limits,
provider errors and output bounds, immutable hashes, expiry/rejection/replay, owner
query scoping, membership checks, run idempotency/fencing, read-event persistence,
server-captured versions, and shared task behavior. Mocked persistence tests are
explicitly labeled; they do not prove real database concurrency or rollback.

Eight new database-backed integration cases use a stubbed provider with real
PostgreSQL services/routes: scoped reads/history, request replay, project-scope
escape, concurrent repeated approval, stale task/sprint versions, report persistence,
expiry, active-run/late-result fencing, same-workspace conversation privacy and
membership revocation. The existing 13 API tests remain. These 21 database tests
require a connected isolated `_test` database and are not marked passed.

Browser coverage adds one AI-review journey per desktop/mobile project, with
explicitly intercepted AI API fixtures: no task writes or approval request before a
click, digest-bound decision bodies, approve/reject, restored UI history, retained
quick drafts and missing-provider state. These are UI protocol fixtures, not live
model/database approval evidence. Together with the prior roadmap journey, four
browser cases were successfully discovered with `--list`; none were executed here.

Standalone SQL checks validate schema/constraints only, not Prisma route execution.
No prohibited database connections, Docker operations, web-server starts or browser
host retries were performed for this milestone. A parallel standalone tsc initially
collided with Next replacing generated type files; it was rerun sequentially after
build completion. This tooling race is not classified as an application regression.

## Database and API changes

Roadmap migration: `prisma/migrations/202611130001_roadmaps/migration.sql`.

AI migration: `prisma/migrations/202611130002_agent_manager/migration.sql` adds
nullable parent links, seven AI/planning tables, scoped foreign keys, status enums,
indexes, date/receipt constraints and active-run uniqueness. It is additive. New
scoped endpoints cover `/api/ai/config`, conversations, conversation messages,
proposal decisions and saved artifacts; the original `/api/ai` endpoint is preserved.

Additive changes only: `Task.startDate`, `Task.isMilestone`, scheduling indexes,
project/task unique index and `TaskDependency` with composite task foreign keys.
Existing task due dates, numbers, assignments, comments and activity are retained.
No production/application database was reset, reseeded or migrated in this session.

Apply with `pnpm db:migrate` and regenerate with `pnpm db:generate` on the target
installation before using the updated app. Back up persistent data before deployment.

| API                                              | Behavior                                                                               |
| ------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `GET /api/roadmap?workspaceId=…&projectId=…`     | Authorized repeatable-read project/tasks/dependencies snapshot                         |
| `POST /api/roadmap/dependencies?workspaceId=…`   | Validated, serialized finish-to-start dependency creation                              |
| `DELETE /api/roadmap/dependencies?workspaceId=…` | Idempotent removal, same JSON edge shape and authorization                             |
| Existing task POST/PATCH                         | Accept `startDate` and `isMilestone`; validate merged schedule; PATCH requires version |

All mutation requests continue to require the configured Origin, JSON content type,
bounded body, session, workspace membership and existing write rate limits.

## Metric definitions and limits

- Completion: count of DONE project tasks / total project tasks; zero for empty projects.
- Overdue: unfinished task with due UTC day before today. Approaching: due day from
  today through today + 3 calendar days, inclusive.
- Ordinary task duration: inclusive UTC due day minus UTC start day + 1.
- Milestone duration: zero. Dependencies: finish-to-start. Ordinary predecessors
  occupy their entire due day; successors start the next day at the earliest.
- Critical path: longest duration path in the project DAG; forward/backward passes
  calculate slack. Zero-slack tasks are critical, including equally critical branches.
  Includes completed work and calendar weekends. Resource constraints, holiday
  calendars and gaps between recorded schedules are excluded. This is a planning
  estimate, not a forecast from engineering throughput.
- Every task needs both dates for CPM. Missing dates produce an explicit incomplete
  state. Existing seeded tasks are not given invented schedules.
- Cycles are prevented by the application service while holding a project lock.
  Direct SQL writers must use equivalent locking/validation; no database DAG trigger
  is claimed. Graph reads are consistent within a repeatable-read transaction.
- Browser windows are bounded to 42/112/365 days per scale and can be paged.
  Timeline layout orders rows chronologically; Gantt preserves project task order.

## Milestone 1 — historical blocked verification attempt, 2026-11-13

Milestone 1's API and browser release gates remain open. The following is the
previous verification attempt; current Milestone 2 results are recorded above. No development/application database was reset, deleted, reseeded or
migrated during this verification attempt; its live migration state is **unknown**.

| Check                              | Actual result                                                                                                                                                                                                |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| PostgreSQL inspection              | PostgreSQL CLI tools and a Unix socket at `/tmp/.s.PGSQL.5432` are present; configured app target is `localhost:5433/devflow`. Running service/database contents cannot be inspected through denied sockets. |
| Development migration status       | `prisma migrate status` failed with P1001. Pending/applied state cannot be asserted. No deploy was attempted against an uninspectable connection.                                                            |
| Connection diagnostics             | TCP to 127.0.0.1:5433 and PostgreSQL Unix socket connect both fail with `EPERM`; Docker API socket access is denied. This does not prove PostgreSQL is stopped on the host.                                  |
| Prisma client generation           | Passed with Prisma 6.19                                                                                                                                                                                      |
| Isolated test database preparation | New `db:prepare:test` command attempted; psql spawning/connection is denied (`EPERM`). No database created and no `.env` changes written.                                                                    |
| API integration suite              | Attempted with process-local isolated `devflow_test` URL. `beforeAll` connection failed; **1 failed suite, all 13 tests skipped**, zero application assertions passed.                                       |
| Direct development server          | `next dev --webpack --hostname 127.0.0.1 --port 3100` failed: `listen EPERM`.                                                                                                                                |
| Desktop/mobile Playwright          | Attempted with isolated server/database configuration. Server startup failed before either project ran; **zero browser tests passed**.                                                                       |
| Browser-access fallback            | Browser host unavailable; no interactive visual verification performed.                                                                                                                                      |
| Full and core TypeScript           | Both passed                                                                                                                                                                                                  |
| Full ESLint                        | Passed                                                                                                                                                                                                       |
| Unit tests                         | **38 passed across 5 files**, including 13 roadmap and 4 database-isolation tests                                                                                                                            |
| Production build                   | **Webpack build passed** compilation, TypeScript, prerendering and trace generation                                                                                                                          |
| Previous PostgreSQL schema checks  | Prior milestone run applied both migrations in an isolated standalone PostgreSQL 18.6 cluster and passed both SQL suites; these are not API/concurrency results and were not rerun in this attempt.          |
| Default Turbopack                  | Prior attempt failed on sandbox socket binding; webpack remains the verified production-build path.                                                                                                          |

### Verification improvements

- Added `scripts/prepare-test-db.ts` / `pnpm db:prepare:test`: validates isolation,
  creates an absent dedicated `_test` database, preserves existing data and deploys
  migrations only to that test target. It persists a derived test URL to ignored
  `.env` only after successful database access. PostgreSQL psql/createdb and a role
  with database-creation privileges are required; credentials are not printed.
- Shared isolation validation compares decoded database names rather than raw
  connection strings, refusing application-database aliases and unsafe names.
  Four unit tests exercise missing/invalid configuration and alias/schema tricks.
- Playwright now requires `TEST_DATABASE_URL`, starts a separate server on port
  3100 with matching APP_URL, and refuses to reuse a development server. Existing
  app data cannot be touched by accidentally reusing the user's port-3000 server.
- API cleanup skips queries when initial connection failed, preserving the original
  infrastructure error rather than producing misleading cleanup failures.
- Expanded API tests for concurrent opposite and transitive dependency edges,
  simultaneous writes sharing one version, unauthenticated mutations, unauthorized
  edge deletion and idempotent dependency removal. **These assertions remain unrun.**
- Expanded desktop/mobile journey for dependency rejection/removal/re-addition,
  pointer/keyboard drag, persisted dates/milestones, resolved schedule warnings,
  dark/light screenshots, Kanban status and analytics rendering; uncaught page
  errors fail the journey. **These assertions and screenshot captures remain unrun.**

No runtime task/graph/authentication regression has been demonstrated by this
attempt, but those features cannot be declared verified without the blocked suites.
Follow [VERIFICATION.md](VERIFICATION.md) for exact Fedora commands, safe database
setup, expected artifacts and visual acceptance criteria.

## Remaining mission and external configuration (reconciled at M3.5 baseline)

| Area                                               | Current state                                                                                        |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Roadmaps/dependencies                              | Source implemented; unit/schema/build checks pass; API concurrency and browser release gates open    |
| Agentic AI tools/approvals/sprints/reports/history | Implemented with available checks passing; live provider/API/browser gates remain open               |
| GitHub objects/webhooks/task linking/PR rules      | M3.1–M3.4 implemented; M3.5 operational acceptance and hardening in progress                         |
| Collaborative documents                            | Not implemented; requires CRDT/editor integration and authenticated transport                        |
| Expanded engineering analytics                     | Planned; existing actual-record analytics preserved                                                  |
| Workflow engine/background jobs                    | PostgreSQL worker, PR status rules and durable execution implemented; generic actions/email deferred |
| Channels/DMs/attachments                           | Not implemented; conversation ACL and storage design required                                        |
| Server full-text global search                     | Planned; existing keyboard palette preserved with roadmap navigation added                           |
| Offline/PWA sync                                   | Not implemented; IndexedDB/version conflict design recorded in plan                                  |
| Full 2.0 redesign/onboarding                       | Not complete; roadmap extends existing responsive dark/light tokens and components                   |

Roadmaps require PostgreSQL and the new migration, with no third-party credentials.
Existing AI requires server `AI_API_KEY`, `AI_BASE_URL`, `AI_MODEL`; GitHub requires
OAuth credentials and `TOKEN_ENCRYPTION_KEY`. No fake AI or GitHub data was added.
Later phases need webhook configuration, jobs, collaborative transport, file storage
and optional email setup. No new third-party network calls or messages were sent.

Git commits were not possible: `.git` is an empty read-only directory, not a usable
repository. Existing user changes were retained. Secrets were neither printed nor
committed.

## Next release gates

1. Apply migrations to a separate `_test` PostgreSQL database and run the API suite,
   especially concurrent graph mutations and archive/edit races.
2. Run desktop/mobile E2E and visually inspect scheduling, dependencies, overflow,
   keyboard drag, reduced motion and both themes.
3. Apply the AI migration to the isolated test database and run its approval/replay/
   concurrency suite, then validate a configured live provider. Milestone 2 source and
   available checks are complete. Milestone 3 remains not started.

## AI chat UX follow-up — 2026-11-13

Implemented a reusable React message/Markdown renderer, scoped theme styles,
responsive real tables, checklists, code language/copy/highlighting controls and
response copy. New conversations and restored saved Markdown use the same renderer;
user prompts remain plain text. Tool calls start collapsed, separate structured
results from assistant prose and retain optional redacted/copyable diagnostic JSON.
Verified DEV references open the existing task view only within authorized snapshot
and conversation scope. Unknown/unloaded references remain text.

The composer supports Ctrl/Cmd+Enter, improved spacing, actual request progress,
existing-idempotency retries and reader-aware scrolling. Quick Drafts' six actions,
endpoint and behavior are unchanged. Proposals retain their original immutable
preview/hash and exact decision payload; previews also offer exact description/report
text. No approval/execution service or provider transport was changed.

Read-only tool improvements add optional `listTasks.scope` (all/mine/unassigned),
server-resolved ownership, conflicting-filter validation and authorized friendly task
metadata. The model context now requests Markdown and readable scoped answers, never
inventing ownership or substituting all tasks for an empty personal query. Original
IDs/enums remain available internally. No migration or new endpoint is needed.

Dependencies: marked 16.4.2, entities 4.5.0, js-tokens 4.0.0; development jsdom 22.1.0.
Registry DNS prevented obtaining react-markdown/remark-gfm. Cached Marked is used only
for lexing into allowlisted React elements, never HTML parsing/injection. Raw HTML,
unsafe protocols, embeds and remote images are disabled. Details and local commands:
`AI_CHAT_UX.md`.

Actual available checks: **99 tests pass in 12 files**, full/core TypeScript, ESLint,
Prisma generation and webpack production build pass. Changed-source formatting passes.
Repository-wide Prettier also reports existing differences in `prisma/seed.ts`,
`src/app/globals.css`, `src/components/kanban.tsx`, `src/lib/server/env.ts`,
`src/lib/server/errors.ts`, `tests/core.test.ts`, and generated `next-env.d.ts`.
These unrelated files were not reformatted. Package importer/integrity/snapshot
consistency was checked. pnpm's automatic install encounters its unwritable SQLite
store here, so available checks used installed `node_modules/.bin` executables.

Added DOM tests cover rendering, safe URLs/HTML, copy, references/scope, tool
collapse/expand, theme-neutral markup, auto-scroll, history remount, explicit
approval/rejection and Quick Drafts. Ownership and provider-context tests extend
existing unit coverage. A new real-DB ownership/history fixture brings integration
coverage to **22 tests**; browser fixture assertions expand the existing four
configured desktop/mobile cases to Markdown, tables, links, tool details and themes.

**Not executed/passed:** real PostgreSQL integration, browser layout/screenshots,
live clipboard behavior and live Groq response generation. Known sandbox EPERM for
connections/listening and Docker denial were not retried. jsdom is not browser visual
verification. The existing configured Groq model/credentials are preserved, but its
response quality must be checked locally. No data reset/migration, secret output,
Git commit or Milestone 3 work occurred. Original API/browser release gates remain open.

## Task retrieval, scope and full Assistant page follow-up — 2026-11-13

**Root cause:** the historical three tasks were unassigned. `scope=mine` correctly
uses the session user's assignee ID and excludes them. No incorrect actor resolution
or accidental loss of those records was found in the code. Present live counts were
not read. A broad project answer had previously been presented as personal work.
The principal problems were ambiguous instructions and disconnected UI scope.

Verified bugs addressed: the shell's selected project was not forwarded to new
Assistant drafts; a loading conversation briefly displayed a workspace fallback;
artifacts stayed workspace-wide beneath a project conversation; Quick Draft state
could survive workspace switching. The inherited project now receives the same
active/archive validation as an explicit project filter. All existing workspace and
private-conversation boundaries remain enforced server-side.

`listTasks` retains the eight-tool registry and legacy arguments, adding optional
`unfinished` and `includeProjectContext`. Strict personal results remain unchanged.
On opt-in empty personal results, only an already-known authorized project receives
a separately labeled bounded context page/exact counts; there is no workspace-wide
fallback. Filtered pagination now exposes nextOffset/hasMore. Creator history is not
reliably stored, so created-by-me is explicitly unsupported without fabricated data,
new schema or backfills. Assignment proposals already validate membership and capture
versions/full previews; that mechanism was preserved rather than bypassed.

The model receives verified workspace/project/user metadata and explicit intent,
archive, pagination, completed-work and creator limitations. Its transport/Groq model
configuration is unchanged. Actual live model compliance has not been demonstrated
by fixtures. `AI_CHAT_UX.md` describes the exact behavior and manual acceptance checks.

The page now has a compact real-scope/model trail, fixed-scope history with explicit
new-scope creation, task-view prompt chips, held loading/archive composer, compact
artifacts, bounded transcript/sticky composer, narrower responsive history and scoped
footer spacing. Tool results show project/due fields and distinguish contextual work
from assigned matches. Copy-selection identity spacing is explicit. Quick Drafts
retains its six read-only actions and now shares safe Markdown/copy/task navigation,
with correct initial project and reset on workspace changes. Theme variables, XSS
rules, task navigation validation and all approval/hash/version/expiry/receipt/audit
services are preserved. No new dependency, endpoint or migration was required.

Actual verification: **118 tests pass in 12 files**, full/core TypeScript, ESLint,
Prisma generation and webpack production build pass. Changed-source formatting
passes. Whole-repository Prettier reports the same seven pre-existing/generated
files: next-env.d.ts, prisma/seed.ts, src/app/globals.css, src/components/kanban.tsx,
src/lib/server/env.ts, src/lib/server/errors.ts and tests/core.test.ts. They were
not reformatted. Installed binaries were used because pnpm's automatic install
hits its already documented unwritable SQLite store.

Discovery succeeded for **23 database integration tests and six browser cases**.
They were **not executed** in this follow-up. One new real-DB fixture covers project
context/workspace scope, unfinished pagination, archive and membership boundaries;
a new browser journey covers task/context navigation on both profiles with real
isolated DB task setup and explicitly intercepted AI responses. Passing DOM tests
are not evidence of live provider or real database behavior.

Visual access was checked: browser inventory has no surfaces and reports
`The browser access host is unavailable`. No screenshots or rendered-page inspection
were possible. PostgreSQL TCP/Unix socket EPERM, Docker denial and server-listen
EPERM remain the prior documented blockers; prohibited operations were not retried.
No application DB reset/deletion/migration, credential exposure, provider request,
Git commit or Milestone 3 work occurred. Runtime/visual acceptance remains open.

## Assistant workspace and Groq reliability stabilization — 2026-11-13

Source audit found competing layout ownership: document-flow shell plus independently
sized/clipped chat, minimum heights and viewport offsets in three stylesheets,
stacked context rows, a 220px history track, unrestricted title wrapping and reports/
footer below the chat. The repair replaces those constraints with a scoped flex/grid
viewport workspace, inherited remaining height and zero minimum sizes. History is
250–310px on desktop and uses the existing focus-managed dialog on narrow screens.
Header context is disclosed on demand; plans/reports occupy a secondary pane. The
composer is a fixed flex sibling of scrolling messages (not position-fixed), starts
at 40px and grows to 144px. Assistant page footer is omitted; other pages are unchanged.
Old layout overrides were removed from message/proposal CSS. Quick Draft switching
retains the selected conversation; title generation still uses the first submitted
request and never automatically renames history.

Provider 429 now has a dedicated safe quota/rate-limit error, valid Retry-After/date
and exhausted Groq reset parsing, safe response headers and advertised cooldowns.
Automatic retry count is zero. Both adapters use bounded process-local backoff keyed
by credential hash, without retaining raw credentials. It is not distributed and
cannot cancel already in-flight requests. Missing timing never invents a delay.
Legacy misleading 429 text is corrected only in presentation. Request UUIDs permit
private failure/delivery correlation; domain approval semantics are unchanged.

Successful full tool results persist before subsequent provider requests. Late
failure remains FAILED, retains verified task records and saves no new proposals.
UI distinguishes failure, retrieved task data and optional diagnostics; interrupted
prepared writes are not presented as saved approval previews. No fabricated answer.
The model receives a derived compact tool view, preserving needed IDs/getTask versions
while omitting duplicate labels/relations/timestamps and repeated full proposal bodies.
Oversized model context no longer overwrites audit records. A fixture checks compact
JSON below 65% of original size; actual Groq token savings have not been measured.

Available verification: **144 tests pass in 13 files**, TypeScript full/core, ESLint,
Prisma client generation and production webpack build pass. Changed-file formatting
passes. Whole-repo Prettier still reports next-env.d.ts, prisma/seed.ts,
src/app/globals.css, src/components/kanban.tsx, src/lib/server/env.ts,
src/lib/server/errors.ts and tests/core.test.ts; unrelated files were not reformatted.
Installed binaries were used to avoid pnpm's previously documented unwritable store.
Discovery lists **24 real-DB integration tests and six browser cases**; discovery is
not execution. New coverage includes 429 headers/backoff, no implicit retry, full
audit/compact-model separation, partial success, history dialog, pane/composer/title
behavior and all prior authorization/approval/task/Markdown/Quick Draft regressions.

**Visual acceptance remains incomplete.** No supplied screenshot files were found
in the repository, and browser inventory returned `The browser access host is
unavailable`. No rendered output or screenshots were inspected/captured. Previous
PostgreSQL socket/HTTP-listen EPERM and Docker denial were not repeatedly retried;
no DB/browser assertions or live Groq request ran. Browser fixtures now target
1440/1024/768/390px, themes, drawer, panes, overflow and partial-rate-limit UI. A new
real-DB fixture checks full read persistence after late 429 without domain writes.
`AI_CHAT_UX.md` and `VERIFICATION.md` provide exact local acceptance commands.

No dependency, migration, secret exposure, app DB reset, domain mutation, Git commit
or Milestone 3 work. Groq configuration, eight tools, private scope, safe Markdown,
immutable proposals/hashes, expiry/version checks, receipts and audit records remain.

## Agent context, read reuse and Groq efficiency follow-up — 2026-11-13

Layout and CSS unchanged. The unnecessary project question came from an explicit
instruction to clarify workspace scope without an active project catalog. Redundant
workspace/project personal reads were separate model choices with no run-local reuse;
zero assigned results were correct for unassigned tasks, not a retrieval loss. The
exact observed quota bucket remains unknown without live usage/header evidence.

Implemented authorized ID/name catalogs with exact totals, unique explicit-name and
established-project resolution, and a sole-active-project default. Explicit assigned
workspace questions stay workspace-wide; current work means unfinished assigned work
in an established/sole project, otherwise workspace assigned work. All-workspace
requests ignore project hints; pinned scope never broadens. Unknown/duplicate names
and complex/mutating requests stay on the agent path.

Narrow read-only intents and task chips now use the existing authorized listTasks
service with zero provider calls, persisted audit and normal idempotent run fencing.
Answers explicitly label deterministic database summaries, actual interpretation,
assignment vs project context and partial-page totals. They do not fabricate ownership,
creator data or an AI answer. Verified reads can operate during provider cooldown;
model requests retain the existing 429/backoff policy and no automatic retries.

Equivalent reads within a model run reuse full results only after membership and
active/project-boundary checks. fresh=true forces rereads; proposal preparation
invalidates reuse. Filters/projects/pages remain distinct and every call is audited.
Reused model messages reference earlier results instead of duplicating arrays. No
cross-user/run cache, eight-tool changes, hash/version/approval weakening or destructive
DB operation. Condensed instructions/catalogs and a paired history budget reduce
provider context; last-query pagination metadata is explicit. Full history is retained.

Optional AI_DIAGNOSTICS logs counts/sizes, safe numeric rate headers and reported token
usage only; no keys, prompts, answers or workspace records. This exposes avoidable
rounds and future real quota evidence, not a claim of measured live token savings.

Executed: **172 tests in 15 files pass**, TypeScript full/core, ESLint, webpack build
and changed-source formatting. Existing seven unrelated/generated repo-format issues
are retained. Used installed binaries to avoid the known pnpm store restriction.
Discovery only: **25 DB integration tests and six browser cases**. Added a real-DB
zero-provider scope/routing fixture; neither real-DB nor browser suites executed here.
No live Groq request or quota probe, package/migration, credential change, app DB reset,
Git commit or Milestone 3. Runtime instructions and exact defaults: AI_CHAT_UX.md and
VERIFICATION.md. Existing UI visual gate is unchanged, not reclassified as passed.

## Fedora integration / E2E repair — 2026-11-13

Fixed the production sprint approval payload in `src/lib/server/agent-tools.ts`.
`SprintTask` shares `projectId` between its composite Sprint and Task relations.
Prisma's generated `SprintTaskUncheckedCreateWithoutSprintInput` accepts `taskId`
and baseline fields, but **does not accept `projectId`**: the nested parent supplies
it. Removed the redundant scalar and added a generated-type `satisfies` check to
prevent reintroducing it. No schema/client compatibility workaround or migration
was needed. The client was regenerated successfully (Prisma 6.19.0).

The existing project lock, authorization, task versions, overlap checks, nested
atomic write, audit record and approval/hash/receipt transaction remain intact.
Five new mocked execution tests cover the valid nested payload and rejection before
writes for changed versions, overlap, foreign tasks and removed membership. The
existing database sprint test additionally checks persisted baseline values and
repeat-approval replay without duplicate sprint or task rows. Its DB execution is
still required; a mocked transaction does not establish Prisma persistence.

Inspected all six original browser traces/error snapshots. Registration succeeded
with 201 but its desktop heading assertion ran during workspace loading. The exact
Assistant navigation name omitted its visible BETA badge. Mobile history used an
immediate visibility probe before the responsive opener mounted. Task priority was
already a native accessible combobox; exact wrapping-label matching was outdated.
E2E helpers now wait for actual snapshot responses/mounted controls, handle an
already open mobile navigation, match the existing badge, and select native fields
by role. Scope controls are opened through their existing disclosure. No sleeps,
timeout increases, layout changes or weakened approval assertions were introduced.

Executed: **177 unit tests pass in 16 files**, full/core TypeScript, ESLint, changed
source formatting, Prisma generation and webpack production build pass. Database
attempt: **2 suite setup failures, 25 skipped tests** because `localhost:5433` is
unreachable. Playwright attempt: server exited with code 1 before browser tests;
**zero cases executed**, with no deeper startup error emitted. The supplied local
24/25 integration and 0/6 browser results are historical input, not current passes.
Original trace directories were preserved and restored under `test-results/`.

No application database writes/resets, live Groq requests, new dependencies,
migrations or Milestone 3 work. Release verification remains open pending a local
isolated PostgreSQL/browser rerun. See `VERIFICATION.md` for commands and details.

## Roadmap dependency removal repair — 2026-11-13

The latest user-run Fedora verification reports **25/25 integration** and **4/6
Playwright** passing, including all four desktop/mobile AI journeys. The two failing
roadmap traces were inspected before editing. Both show the intended removal button
being clicked and a DELETE response of **400**, with `Input: Unrecognized key(s) in
object: 'createdAt'`. This is a production request-serialization bug, not a timeout
or an inaccurate `.roadmap-dependencies li` assertion.

`getRoadmap` returns persisted dependency rows with `createdAt`. Creation constructs
only three identifier fields, but removal forwarded the entire loaded row. The
strict API schema rejects its extra timestamp before entering the deletion service;
the row therefore remained in the database and in the rendered list. The list maps
only actual dependency records. Existing successful-mutation refresh logic was
correct and was never reached on this validation failure.

The client now projects both dependency commands to exactly `projectId`,
`predecessorId` and `successorId`. Server validation, authorization, project locking,
cycle checks, idempotent deletion, audit, task versions and scheduling are unchanged.
No E2E selector/assertion, timeout, layout, dependency, schema or migration changed.

Added `tests/roadmap-interface.test.ts`: render a real Roadmap with a loaded edge
containing `createdAt`, click its actual removal button, validate the outgoing
request with the shared strict API schema, then assert query refresh, removal from
the list and the empty state. This is a mocked HTTP/component regression, not a
claim of real PostgreSQL persistence. The existing database suite already tests
persisted deletion/repeated deletion, cycles and concurrent graph writes.

Current sandbox execution: **178 unit tests passed in 17 files**, full/core
TypeScript, ESLint, webpack production build and changed-file formatting passed. The database attempt failed both initial connection hooks
(`localhost:5433` unreachable), skipping 25 tests. The Playwright attempt executed
zero cases: debug logging confirms `connect EPERM 127.0.0.1:3100`, then the isolated
web server exited with code 1. Original Fedora trace directories were preserved and
restored. Full/core TypeScript and webpack results are recorded in VERIFICATION.md.
No development database writes/resets, live Groq requests or Milestone 3 work.

## M3.1 — GitHub repository connection and webhook foundation (2026-11-13)

### Architecture and implementation

Audited the three existing migrations, OAuth state/session handling, encrypted
GitHub tokens, repository/activity reads, project string links, workspace roles,
Origin/body guards, project locks, activity and AI receipt patterns. Reused those
boundaries; no OAuth replacement, GitHub App installation, task mutation or workflow
engine was added. Milestone 3 is divided into M3.1–M3.5 in UPGRADE_PLAN.md. Only
M3.1 is implemented in this change.

M3.1 reuses OAuth for a fresh GitHub repository-admin check, then provides manual
repository-webhook setup with a distinct per-connection random secret. GitHub OAuth
neither creates hooks nor authenticates webhook requests. A future GitHub App needs
installation reconciliation/revocation and narrower permissions, rather than a
partial installation flow now. See GITHUB_INTEGRATION.md for the decision, GitHub
primary-source references, permissions, complete setup steps and endpoint contracts.

- Workspace owner/admin plus GitHub repo admin may connect an active repository to
  an authorized active project. Metadata stores canonical repository ID and name,
  composite project/workspace scope and provisioning actor. Existing activity links
  continue to work and are updated transactionally; they never authorize webhooks.
- Separate raw-byte HMAC SHA-256 receiver, constant-time comparison, 1 MiB bound,
  event allowlist and repository-ID validation. No raw payload/profile/email/body
  retention; commit facts/references are bounded and truncation is explicit.
- Durable PENDING receipts before 202 acknowledgment; uniqueness by connection and
  delivery ID plus exact-body digest. Matching replays return 200 without new work,
  changed content under a delivery ID returns 409. Changing an unsigned delivery ID
  cannot enqueue the same signed body again. Exact replay aliases reuse the original
  canonical receipt rather than generating extra audit/work rows.
- Project/connection row locks serialize acceptance, connection creation and safe
  disconnect. Soft disconnect erases its secret, cancels unfinished inbox work,
  preserves historical receipts and creates activity. Archived projects reject
  ingestion but allow disconnection. Reconnect creates a new ID/secret.
- Existing GitHub picker connects projects and opens a one-time setup dialog;
  management/disconnect remains available independently of the user's OAuth token.
  Workspace changes reset that page's local state. AI Assistant layout untouched.
- No processor/retry runner/automation exists. Queue lease/status fields reserve the
  next phase's contract; future workers must fence disconnected/archive states,
  reconcile current GitHub facts and implement idempotent side effects.

### Additive migration

`202611130003_github_webhook_foundation` adds `GitHubRepositoryConnection`,
`GitHubWebhookDelivery` and `GitHubDeliveryState`. Composite workspace/project FK,
canonical receipt uniqueness, exact-body replay uniqueness, queue/list indexes,
positive repository ID and nonnegative attempt checks, and a partial unique index
for one active connection per project. Existing tables gain only Prisma inverse
relations; no existing record is rewritten/backfilled or reset. SQL is transactional.
The partial index is maintained in SQL (not represented as a Prisma conditional
index). Normal `migrate deploy` is required before running the new endpoints.
Migration/client generation and schema validation are local operations; no database
migration has been applied from this sandbox.

### File manifest

| Area               | Files                                                                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema/migration   | `prisma/schema.prisma`; new `prisma/migrations/202611130003_github_webhook_foundation/migration.sql`                                              |
| Server             | new `src/lib/server/github-webhook.ts`, `src/lib/server/github-repositories.ts`; modified `src/lib/server/github.ts` (refuse redirects)           |
| Routes             | new `src/app/api/github/webhooks/[connectionId]/route.ts`; modified `src/app/api/[...path]/route.ts` (management endpoints and legacy-link guard) |
| UI                 | `src/components/integrations.tsx`; `src/components/devflow.tsx` (GitHub workspace key only)                                                       |
| Tests              | new `tests/github-webhook.test.ts`, `tests/github-repositories.test.ts`, `tests/github-interface.test.ts`, `tests/github.integration.test.ts`     |
| Configuration/docs | `.env.example`, `tsconfig.core.json`, new `GITHUB_INTEGRATION.md`, `UPGRADE_PLAN.md`, `UPGRADE_REPORT.md`, `VERIFICATION.md`                      |

### Remaining acceptance and M3.2 work

External OAuth/repository setup, real GitHub ping/redelivery and browser visual
acceptance need credentials/reachable HTTPS and an unrestricted environment. There
were no live GitHub/Groq calls. The existing GitHub picker retains its 100-repository
limit; the authorized API supports an explicit name. Permission/repository transfer
lifecycle reconciliation, automated hook registration and GitHub App installations
are not implemented. Keep the remote hook disabled/removed when disconnecting.

M3.2 remains unstarted: leased inbox processing, latest-fact reconciliation, bounded
retry/backoff, commit/PR/issue/CI views and verified task-reference association. No
automatic task transitions are authorized by M3.1. Later M3.3/M3.4 add versioned
workflow definitions and idempotent execution; M3.5 covers operational acceptance.
See VERIFICATION.md for exact executed checks and blocked gates.

M3.1 verification result: **206 unit/DOM tests passed in 20 files**; Prisma client
generation/schema validation, full/core TypeScript (after build), ESLint,
changed-file formatting and webpack production build passed. The isolated database
attempt produced **3 setup failures / 34 skipped tests** at initial PostgreSQL
connections; none of the nine new GitHub DB cases executed assertions. Browser/live
GitHub checks were not attempted under the previously documented restrictions.
No migration or fixture writes reached either application or test database here.

## M3.2 — GitHub webhook event processing (2026-11-14)

Implemented only M3.2a–e on top of the user's manually verified M3.1 ingress.
PostgreSQL is the durable queue; a separate supervised Node worker consumes it.
No Redis/BullMQ, new runtime dependency, GitHub App migration, task-changing workflow,
AI feature or unrelated UI redesign was introduced.

### Processing and integrity

Claims are short atomic SKIP LOCKED CTE updates, optionally scoped to a connection.
Database-time leases carry random ownership tokens and renewal. Recovery handles
expired/legacy leases and attempt-limit changes. Fenced completion locks project →
connection → delivery and rechecks active scope/lease before bulk publication and
again at final acknowledgment. All effects/PROCESSED transition commit together.
Failure is retryable with bounded jitter/backoff and provider timing, or terminal
FAILED with deadLetteredAt. Once mode bounds attempted jobs; shutdown drains work.
This is at-least-once processing with idempotent database effects, not exactly-once.

Object identities use project/repository/kind plus SHA, PR/issue number or workflow
run ID. Associations are unique object/task pairs and evidence retains observation
provenance. Multiple deliveries may observe the same object without duplicating its
identity or task links. SQL composite FKs enforce object/repository/project/delivery/
task compatibility. Immutable observations preserve actual webhook facts separately
from authorized API snapshots/read times. Strictly newer source timestamps alone
advance mutable projections. Legacy facts have no invented current-state timestamp.

DEV references are resolved inside the bound project/workspace only. Unknown/deleted/
foreign references remain unresolved. Workflow head-commit references are used only
when actually supplied; no associations are invented for legacy runs. Ping has no
objects or task activity. The worker never calls task mutation services or writes
human TaskActivity. Task status/assignee/priority/version/completion/sprints stay intact.

Enrichment defaults off. A current workspace owner/admin explicitly authorizes their
own OAuth account after fresh repo-admin/identity verification. Each request and
publication checks the current grant, role and credential snapshot; revocation
falls back to signed local facts, never another member's token. Metadata identity
is checked before and after fetched data. Fixed paths, redirect refusal, response/
time limits, three-page compare bounds and incompleteness markers protect reads.
Rate-limit metadata is sanitized and cooldowns are persisted by credential hash
using monotonic SQL GREATEST, shared across workers. No transport auto-retry bypasses
provider waits. Real remote lifecycle changes still need operational/admin oversight.

### Migration and backward compatibility

New migration `202611140001_github_processing` adds leaseToken/leaseExpiresAt,
deadLetteredAt and dataVersion (default 1), explicit enrichment authorization/version,
GitHubObjectKind and GitHubObject/GitHubObservation/GitHubTaskLink/GitHubTaskLinkEvidence.
It adds scoped FKs, object/evidence uniqueness, queue/recovery/object/task indexes and
positive-version checks. Existing M3.1 JSON and delivery receipts are not rewritten,
deleted, reset or reseeded. New ingress stamps version 2; schemas read both versions.
The migration was generated without database access and was attempted only after
verifying the exact target `/devflow_test`. P1001 prevented application there; no
application migration was attempted. Manual deployment commands are documented.

### Files created or modified

| Area                 | Files                                                                                                                                                                                                                                                           |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Database             | `prisma/schema.prisma`; new `prisma/migrations/202611140001_github_processing/migration.sql`                                                                                                                                                                    |
| Worker/processing    | new `src/lib/server/github-processing.ts`, `github-worker-runtime.ts`, `github-job.ts`, `github-event-handlers.ts`, `github-activity.ts`, `github-task-links.ts`                                                                                                |
| Enrichment/transport | new `src/lib/server/github-request.ts`, `github-enrichment.ts`; updated `github.ts`, `github-repositories.ts`, `github-webhook.ts`                                                                                                                              |
| Monitoring/API       | new `src/lib/server/github-monitoring.ts`; updated `src/app/api/[...path]/route.ts` and OAuth callback route (validate typed profile response)                                                                                                                  |
| UI                   | new `src/components/github-processing.tsx`; updated `integrations.tsx`, `devflow.tsx` for scoped task-detail callback                                                                                                                                           |
| Execution/deployment | new `scripts/github-worker.ts`, `tsconfig.worker.json`, `deploy/devflow-github-worker.service`; updated `package.json`, `.env.example`                                                                                                                          |
| Build hygiene        | `tsconfig.json`, `tsconfig.core.json`, `eslint.config.mjs`, `.gitignore`, `.prettierignore` (exclude generated `.worker/`)                                                                                                                                      |
| Tests                | new `tests/github-processing.test.ts`, `github-worker.test.ts`, `github-task-links.test.ts`, `github-request.test.ts`, `github-enrichment.test.ts`, `github-monitoring.test.ts`, `github-processing-interface.test.ts`, `github-processing.integration.test.ts` |
| Documentation        | `UPGRADE_PLAN.md`, `UPGRADE_REPORT.md`, `VERIFICATION.md`, `GITHUB_INTEGRATION.md`                                                                                                                                                                              |

### Verification and remaining gates

Targeted tests ran after the phase implementations. Full unit/DOM tests include all
existing AI approval, webhook signature/replay and roadmap cases. New real-PostgreSQL
cases cover competing workers, expired/stale leases, crashes/rollback/final expiry,
retry/dead-letter, duplicate associations, scope constraints, disconnect races,
out-of-order state, monitoring/retry authorization and credential revocation. These
are written tests, not claimed PostgreSQL passes. Exact execution counts and commands
are recorded in the latest VERIFICATION.md section.

No live GitHub enrichment, Groq request, installed worker service or application DB
mutation occurred here. Existing real PENDING ping/push should be drained manually
only after local migration/integration verification; GITHUB_INTEGRATION.md gives an
exact connection-scoped once-mode command. Retention cleanup, long-term alerts,
GitHub App lifecycle/repository-transfer reconciliation and task-changing workflows
remain limitations/future phases. Equal-time conflicting snapshots are conservatively
not allowed to overwrite a projection; they remain observations for inspection.

Final M3.2 available verification: **239 unit/DOM tests passed across 27 files**,
Prisma schema/client validation/generation, full/core TypeScript after Next build,
standalone worker compilation, ESLint, changed-file formatting and webpack build
passed. Guarded test migration failed P1001; integration had **4 setup failures and
47 skipped cases**; Playwright executed **zero cases** due localhost EPERM/server
startup failure. These are open release gates, not passed concurrency/browser tests.
All M3.2 source phases are implemented; external runtime acceptance remains pending.

## M3.2 commit-to-task association repair — 2026-11-14

Root cause verified in code: reference regexes required `[1-9]` immediately after
`DEV-`, rejecting the reported `DEV-002` before task lookup. Raw commit messages are
intentionally discarded during normalization; object/observation builders retain
only extracted refs and selected commit facts. Thus an empty-ref PROCESSED record
cannot recover the original reference from stored JSON. Live DB JSON was not read
here; the exact-message regression confirms the deterministic failure mechanism.

Added a small shared `src/lib/task-reference.ts` canonicalizer: padding aliases map
to the same positive numeric task; raw extraction, persisted-ref validation, task
query/linking and unresolved-ref formatting now agree. Existing project/workspace
lookup predicates and numeric query bounds remain. No key/number/schema changes.

Added explicit `github-reconciliation.ts` plus a strict admin POST endpoint for an
already-observed commit SHA/unique prefix. It requires the caller's own explicit
enrichment grant, fresh repository admin/identity checks and exact commit SHA from
GitHub. It rechecks authorization/disconnect under existing lock order and reuses
scoped idempotent association functions. It writes no new observation/object/delivery
and does not alter task fields. Original observation data remains immutable; the
human-request audit records recovered GitHub API references separately. This is not
requeueing processed jobs or weakening webhook replay protections.

Changed files: new `src/lib/task-reference.ts`, `src/lib/server/github-reconciliation.ts`,
`tests/github-padded-reference.test.ts`, `tests/github-reconciliation.test.ts`;
modified `src/lib/server/github-webhook.ts`, `github-event-handlers.ts`,
`github-task-links.ts`, `github-activity.ts`, `src/app/api/[...path]/route.ts`,
`tests/github-processing.integration.test.ts`, `GITHUB_INTEGRATION.md`,
`UPGRADE_REPORT.md`, `VERIFICATION.md`, `UPGRADE_PLAN.md`. No dependency, migration or UI changes.

Regression uses the exact reported message and Task.number 2 in mocked authorized
lookup; DB tests allocate their own sequence values and pad them instead of resetting
or commandeering task number 2. New tests cover alias dedupe, legacy padded refs,
scoped lookup, explicit grant/role checks, ambiguous prefixes, SHA mismatches,
revocation, permission loss and repeat reconciliation. Two new PostgreSQL cases
verify normalization/linking and preservation of processed receipts/objects/
observations/task data during reconciliation. Actual executed results are in
VERIFICATION.md. No live GitHub request, live reconciliation, development DB change,
reset or M3.3/M3.4 work was performed. Safe manual instructions are in the latest
GITHUB_INTEGRATION.md section; restart both receiver and rebuilt worker.

Repair verification: **248 unit tests passed (29 files)**; full/core types, ESLint,
worker compilation, webpack build and changed-file formatting passed. Verified target
`devflow_test` integration setup failed at localhost:5433: **4 setup failures / 49
skipped**, not database passes. The existing live 9023d37 commit still requires the
explicit local reconciliation action; no application records were changed here.

## M3.2 task GitHub visibility — 2026-11-14

User verification confirms 9023d37 is already linked to DEV-002. This change displays
existing associations directly in the original task detail dialog; it does not run
a repair, reprocess deliveries, change task fields or add automation.

Added a compact full-width GitHub activity section below the editor/comments area.
It lists associated commits, PRs, issues and workflow runs with repository name,
SHA/number, known recorded status and safe external link. Loading/error/empty/retry,
source-age, pagination and disconnected/history states are supported. Task cards
show a passive accessible GitHub/fork count inside the existing open-task button.
The existing drag grip/listeners and editor/comment/save/delete behavior are intact.
Design uses existing theme variables/buttons and responsive wrapping; no separate
page, dependency or migration was introduced.

The authenticated GET `/api/tasks/:id/github` independently verifies membership and
project/workspace scope, reads only authorized associations and minimal connection
metadata, and returns a small no-store DTO. Private raw JSON/profiles, encrypted
credentials and webhook secrets are not exposed. URLs are constructed/validated from
repository/object identifiers on both server and client. Historical observations are
not labeled current live GitHub state. Card counts use the existing relation in
snapshot/task response includes, not per-card API calls. Task field mutation services
are unchanged apart from returning the additional read-only count.

Files: new `src/lib/github-task-activity.ts`, `src/lib/server/task-github.ts`,
`src/components/task-github-activity.tsx`, `src/components/task-github-activity.css`,
`tests/task-github.test.ts`, `tests/task-github-interface.test.ts`,
`e2e/task-github.spec.ts`; modified `src/app/api/[...path]/route.ts`,
`src/lib/server/tasks.ts`, `src/lib/types.ts`, `src/components/task-dialog.tsx`,
`src/components/kanban.tsx`, `tests/github-processing.integration.test.ts` and the four
upgrade/GitHub/verification documents. No Prisma schema changes.

Available checks: **257 unit/DOM tests passed in 31 files**, full/core TypeScript,
ESLint, worker compilation, webpack build and changed-file formatting pass. PostgreSQL
attempt: **4 setup failures, 52 skipped** because localhost:5433 is unreachable.
Playwright: **zero cases executed**, server/localhost checks fail EPERM. Nine new
service/DOM cases, three new DB cases and desktop/mobile browser fixture coverage
are present; only the service/DOM cases executed. No live GitHub/OAuth/Groq calls,
application-data changes or new screenshots are claimed. Browser visual acceptance
remains open; GITHUB_INTEGRATION.md gives the exact Board → DEV-002 → task-dialog
GitHub activity path and local verification guidance.

## M3.3 — workflow definitions and dry-run evaluation (2026-11-15)

Implemented project-scoped rule configuration using existing PostgreSQL, Zod,
session authorization, project locks, catch-all APIs and Radix dialog/design tokens.
No worker/transport/AI/task mutation code was changed. No external calls are made
by rule configuration or evaluation. No dependency or environment variable added.

`GitHubWorkflowRule` supports four PR triggers, optional repository connection,
validated task target status, enabled flag (default false), priority and optimistic
version. `GitHubWorkflowRuleRevision` retains actor ID, immutable API snapshot,
operation, version, request UUID and request hash. CRUD locks project first; concurrent
edits reject stale versions. Replayed identical commands reuse receipts; conflicting
reuse returns 409. Delete disables and soft-deletes a definition, retaining history.
The additive migration creates these two tables and one enum, scope/receipt/version
constraints and indexes, plus a redundant composite unique connection key needed
for the scoped FK. It does not update existing data, tasks or delivery records.

Owners/admins open Projects → Workflow rules on a project card. The dialog provides
CRUD, enable/disable, priority, repository selection, paginated PR observations,
explicit disabled-rule simulation and paginated revision history. Archived projects
are readable/previewable (blocked result) but reject configuration mutations.
Disconnected definitions can still be disabled or deleted; enabling a rule bound
to a disconnected connection is rejected.

Dry runs use a repeatable-read snapshot of real observation data and its specific
task-link evidence. Original webhook facts, rather than enrichment/reconciled API
actions, determine the trigger. Results show candidate rule reasons, winning rule
and task versions, hypothetical/no-op labels, blockers and proposed status transition.
Freshness requires a reliable v2 timestamp equal to the object source timestamp,
no contradictory current projection, age at most seven days and no more than five
minutes future skew. Missing/unresolved/multiple task references block a transition.
An earlier identical webhook fact observation is flagged as a duplicate. Different
targets at the lowest matching priority block; lower-priority disagreements are
reported as overridden. Repeated preview calls do not persist anything.

Files added: `src/lib/github-workflows.ts`, `src/lib/server/github-workflows.ts`,
`src/components/github-workflow-settings.tsx`, the additive migration, three unit/DOM
files (`tests/github-workflows*.test.ts`), `tests/github-workflows.integration.test.ts`
and `e2e/github-workflows.spec.ts`. Files updated: Prisma schema, catch-all API,
project cards in `workspace-views.tsx`, scoped CSS in `globals.css`, core TS config
and the four milestone documents. Existing worker, webhook verification, task links,
AI approvals and task editors remain outside this change.

Latest available checks passed: **301 unit/DOM tests across 34 files**, full/core
TypeScript, ESLint, Prisma validation/generation, worker compilation, webpack build
and changed-file formatting. Test-only migration returned P1001 at localhost:5433;
**all 61 integration tests were skipped** after five connection-hook failures.
Playwright executed **zero browser tests** because its server failed to start; a
separate discovery listed 10 cases and is not a pass. Exact Fedora commands are in
VERIFICATION.md. PostgreSQL integration and visual acceptance remain open. No application
database migration, reset, reseed, live GitHub/Groq call or local Git commit occurred.
The supplied live commit 9023d37/DEV-002 association was not changed. A commit is not
a PR event: previewing “PR merged → Done” needs a real stored merged PR observation
with evidence for that task. Instructions: GITHUB_INTEGRATION.md, M3.3 section.

## M3.4 — safe GitHub workflow automation (2026-11-15)

Implemented two durable stages in the existing PostgreSQL/Node worker. Stage one
publishes normalized objects/observations/task evidence and a pending or terminal
execution record in the original lease-fenced delivery transaction. Stage two uses
short SQL-only transactions, project-first locks and task version CAS to commit
status, execution outcome and exactly one machine-attributed activity atomically.
No external request occurs inside either database transaction. Delivery processing
is at-least-once; uniqueness/CAS/transaction boundaries provide idempotent effects,
not a claim of globally exactly-once execution.

The shared M3.3 stored-observation evaluator still serves read-only previews. Rules
must be explicitly confirmed, enabled, undeleted and match the activation's exact
version. Confirmed edits start a new boundary. The activating administrator's current
workspace role is revalidated and locked for the action transaction; no arbitrary
member OAuth credential is selected. Equal-priority conflicts, incomplete/ambiguous
references, stale/current-projection mismatches, disconnection, archive and missing
source facts remain blockers. Changes after planning to task version/status or rule
version/selection become terminal conflicts/skips rather than overwriting new work.

Migration `202611150002_github_workflow_execution` adds `GitHubWorkflowExecution`,
execution/activity enums, scoped provenance FKs/indexes, unique observation/event
claims and unique activity receipts. A delivery `automationVersion` defaults to **0**
for every existing row; only the updated verified webhook receiver stamps **1** on
new inserts. Rule activation time/authorizer/version default null. Existing enabled
M3.3 definitions therefore remain preview-only until confirmed. Both event source
time and delivery receipt must postdate activation. Previously processed PR #1 is
never scanned or queued; redelivery/retry cannot upgrade historical receipt flags.
No migration was applied to the application database here.

TaskActivity now supports `source=GITHUB_AUTOMATION`, null human actor, and one
execution ID. Database checks forbid machine activity with a human actor. Both task
detail history and workspace feeds render GitHub automation distinctly. Existing
human rows/default attribution remain valid. Status transitions reuse the extracted
existing completion-date helper: entering Done sets/preserves completedAt, leaving
Done clears it; only status/version/updatedAt and those established completion
semantics change. No assignment/priority/sprint/title/description updates occur.

Pending execution rows survive crashes. Transaction locks release on rollback;
original expected task versions are retained. Transient DB failures schedule bounded
jitter/backoff using existing worker options; permanent problems, validation errors,
skips and conflicts are terminal. Failure accounting re-locks in project-first
order and cannot overwrite another worker's terminal success. Execution failures
are visible independently of a successfully processed delivery. There is no API to
force an execution or retry a terminal action; require a new eligible source event.

Settings now explain disabled/preview-only/confirmed automation, require a native
confirmation before enabled saves, and show filtered/paginated outcomes with safe
PR links and existing task navigation. UI-only browser fixtures cover refreshed
Kanban and null-actor activity presentation; they are not live automation evidence.
The existing 30-second snapshot refresh updates cards; task dialogs show fresh
activity when opened/refetched. No editor/DnD/AI layout redesign was introduced.

### Files created

- `src/lib/server/github-workflow-evaluation.ts` (shared authorized/fenced read path).
- `src/lib/server/github-automation.ts` (planning, guarded actions, retries).
- `src/lib/server/github-automation-monitoring.ts` and `src/lib/github-automation.ts`.
- `src/lib/server/task-status.ts` (existing status semantics, shared by human writes).
- `prisma/migrations/202611150002_github_workflow_execution/migration.sql`.
- `tests/github-automation.test.ts`, `tests/github-automation-monitoring.test.ts`,
  `tests/github-automation.integration.test.ts`, `e2e/github-automation.spec.ts`.

### Files modified

- `prisma/schema.prisma`.
- `src/lib/server/github-repositories.ts`, `github-workflows.ts`, `github-job.ts`,
  `github-worker-runtime.ts`, `tasks.ts`.
- `src/lib/types.ts`, `src/app/api/[...path]/route.ts`.
- `src/components/github-workflow-settings.tsx`, `workspace-views.tsx`, `devflow.tsx`,
  `task-dialog.tsx`; `src/app/globals.css`.
- `tsconfig.core.json`.
- `tests/github-workflows-server.test.ts`, `github-workflows-interface.test.ts`,
  `github-workflows.integration.test.ts`; `e2e/github-workflows.spec.ts`.
- `UPGRADE_PLAN.md`, `UPGRADE_REPORT.md`, `VERIFICATION.md`, `GITHUB_INTEGRATION.md`.

No package, credential/example env, AI approval/provider, raw-signature verifier or
GitHub task-link algorithm change was needed. No dependency or second service added.

### Verification

Available checks passed: 323 unit/DOM cases in 36 files; full/core TypeScript, ESLint,
Prisma validation/generation, worker compilation, webpack build and changed-file
formatting. PostgreSQL migration failed with P1001 for verified devflow_test at
localhost:5433; six integration setup hooks failed and **all 82 tests skipped**.
Playwright failed with socket EPERM before its server started; **zero browser cases
executed**. Discovery lists 12 cases. No new screenshot/live GitHub/Groq acceptance
was claimed. Exact commands and remaining release gates: latest VERIFICATION.md.

The user-reported successful M3.3 DEV-002/PR #1 dry run is accepted context, not a
new agent-run acceptance result. This turn did not modify that task, its disabled
rule/version/history, any webhook receipt, or any application data. Local live
acceptance must use a NEW PR following GITHUB_INTEGRATION.md. M3.5 was not started.

## M3.4 follow-up — repair PostgreSQL fault-injection tests (2026-11-15)

The reported Fedora result (68 passed, 14 failed) matches a test-only Prisma/Vitest
proxy interaction. Seven automation tests run before the crash test; that test's
spy then corrupts the shared client for the following thirteen tests. Production
client initialization, authorization and transaction services were not the cause.

Reproduced offline against the actual installed Prisma 6.19 client and Vitest 3 spy:
reading `$transaction` returns a function, but its own property descriptor reports
`value: undefined`. `vi.spyOn` records that descriptor as the original. Once its
one-shot implementation is consumed, the fallback returns undefined without calling
the retry-accounting callback. Thus the crash transaction rolls back correctly but
no bookkeeping transaction runs: PENDING/0/null is left behind. `mockRestore` then
restores undefined, causing subsequent `db.$transaction is not a function` failures.

Both integration fault-injection sites now use `tests/transaction-abort.ts`. It
captures the real method through ordinary lookup, explicitly restores it before
running the aborting transaction, and restores it again in finally. The real
transaction callback still performs status/activity/outcome writes before the
injected error causes rollback. The worker's separate failure transaction is
therefore real, preserving durable retry accounting. No production transaction,
lease, authorization, grant, idempotency or historical-event safeguard was changed.

Existing assertions for rollback, PENDING/attempts=1/DATABASE_TRANSIENT_FAILURE,
retry success, exactly one activity, permanent failure and exhausted attempts remain.
New assertions prove the aborted callback reached APPLIED/STATUS_CHANGED before the
forced rollback, and the original method reference is restored. Three new unit
regressions use the real Prisma proxy with an in-memory backend (no DB connection)
to cover rollback plus separate accounting, continued transactions after mock
cleanup, propagated errors and an injection that never reaches a transaction.

Exact changed files: `tests/github-automation.integration.test.ts`,
`tests/transaction-abort.ts`, `tests/transaction-abort.test.ts`, `UPGRADE_REPORT.md`,
`VERIFICATION.md`. No production or migration changes, live rules, live task writes,
GitHub/Groq calls or milestone additions occurred.

Actual verification: 326 unit tests passed in 37 files; full/core TypeScript,
ESLint, Prisma generation, webpack production build and changed-file formatting
passed. All 82 integration tests were attempted against validated devflow_test;
six connection hooks failed at localhost:5433 and every test was skipped. This is
not an 82/82 database pass. Rerun the unchanged 82-test suite on Fedora with the
already-migrated isolated database using the latest VERIFICATION.md commands.

## M3.5 step 1 — baseline verification and documentation reconciliation (2026-11-15)

Starting state: `feat/m3-5-operational-readiness` at `48d7b5c`, with a clean working
tree and empty index. The owner created the branch locally. The approved workflow
requires one logical change, relevant checks, exact local commit commands, then a
pause until the owner confirms that commit. No staging, commit or branch-write
operation is attempted in the sandbox.

The baseline reproduced 326 passing unit/DOM cases across 37 files; schema
validation/client generation, ESLint, worker compilation and webpack build passed.
Full/core TypeScript and final formatting are recorded in VERIFICATION.md. The
existing isolated devflow_test target was validated before the database suite:
six connection hooks failed at localhost:5433, all 82 cases skipped, zero passed.
Playwright's server probe returned EPERM at 127.0.0.1:3100, the server exited 1,
and zero browser tests or screenshots executed. Discovery lists 12 cases only.
These are environment blockers, not confirmed application assertion failures.

The repository-wide Prettier check was also executed and failed on four existing,
unchanged files: prisma/seed.ts, src/lib/server/env.ts, src/lib/server/errors.ts and
tests/core.test.ts. The four milestone documents pass their targeted formatting
check. This source/test formatting failure is not hidden as an infrastructure skip
and is not repaired inside the documentation commit. After the owner confirms step
1, prepare a separate `chore: normalize baseline source formatting` change before
claiming a green repository-wide format gate.

This change updates only UPGRADE_PLAN.md, UPGRADE_REPORT.md, VERIFICATION.md and
GITHUB_INTEGRATION.md. Current status now distinguishes implementation, historical
verification records, present sandbox results and pending acceptance. Older test
counts and owner-reported live observations are retained as dated evidence; none
were silently converted into new passes. The older broad workflow-builder/email
mission is explicitly deferred rather than folded into M3.5.

No health model/API/UI, revalidation code, retention job, CI configuration, schema,
migration, task service or worker behavior changed. M3.5 steps 2–9 remain pending.
Retention remains policy/dependency analysis and dry-run reporting only; operational
receipts, snapshots, evidence and audit records must not be deleted or archived.
Connection revalidation will be explicit and administrator-authorized, with no
silent identity or connection-state changes and no borrowing another user's token.

No application database query/migration/reset/seed, live worker, live GitHub/Groq
request, webhook creation, rule enablement or DEV-002 change was performed. The only
attempted database suite was guarded to devflow_test. Browser artifacts were routed
to /tmp so existing local reports/traces were preserved. No architecture change or
external service is introduced by this documentation step.

Commit to create locally: `docs: reconcile milestone status and operational acceptance gates`.
The owner must confirm the commit before step 2 starts. No new commit hash is claimed
here; Git remains authoritative. M3.5 remains incomplete until required automated,
browser, deployment and separately authorized live acceptance evidence is recorded.

## M3.5 step 2 — durable worker-health persistence (2026-11-15)

Starting branch feat/m3-5-operational-readiness; owner commits f1a1a2b and f101e28
verified with a clean tree. This focused change adds one additive operational
signal model/migration, the recorder/classifier, worker lifecycle wiring and
unit/PostgreSQL tests. Administrator endpoints/panels remain steps 3–4.

Signals separate independent liveness, completed polling, connection-specific
attempt progress and terminal lifecycle. Bounded runs never assert continuous
availability; idle workers need no successful deliveries to be healthy. Fresh
heartbeat without recent polling is insufficient evidence. Multiple process runs
remain distinct, stale replicas cannot overwrite replacement signals, and ended
runs cannot be revived by late heartbeats. Evidence states are not automatic alerts.

Queue claim/renew/recovery code is unchanged. Delivery/automation functions expose
only an optional synchronous in-memory attempt observer after their transaction
settles; task status/version/approval/audit logic is unchanged. Monitoring database
writes are outside job transactions and preserve project-before-connection lock
ordering. Mid-run monitoring failures are sanitized and cannot cause job replay.

No migration, worker or live call was run against application data, live rules or
DEV-002. The isolated devflow_test connection probe failed at localhost:5433; new
PostgreSQL cases are written but unexecuted. The additive migration is un-applied
here. Unit/static/build results and owner-local verification commands are recorded
in VERIFICATION.md. Live/database acceptance is not substituted with mock evidence.

Prepared commit: `feat(ops): persist scoped worker health signals`. Wait for the
owner's successful commit confirmation before step 3. M3.5 remains incomplete.

## M3.5 step 3 — authorized operational summaries (2026-11-17)

Confirmed owner commit 8fbdc3e and clean feat/m3-5-operational-readiness. New
repository-scoped health GET uses existing authentication/membership checks,
workspace owner/admin authorization and project lookup. All reads are scoped to
the authorized connection and use a consistent database-clock snapshot. The new
endpoint is read-only and no-store on success/error. Step 2 classifier semantics
are unchanged; its input type is narrowed to the evidence fields actually used.

The response contains scoped worker health/timestamps, aggregate delivery and
workflow lifecycle/scheduling counts, and static actionable diagnostics. It
includes no cross-workspace worker run IDs, job payloads, tokens, stored provider
errors, task data or rule snapshots. Representative evidence buckets preserve
healthy replica visibility without returning unbounded historical signals. Idle,
backoff, bounded and insufficient-evidence states do not generate invented host
failure or queue-delay alerts. Disconnected/archived scope overrides fresh signals.

Unit/route and PostgreSQL authorization/privacy/regression cases accompany this
change. Exact results are in VERIFICATION.md. A guarded connection probe still
cannot access localhost:5433/devflow_test; new integration tests are unexecuted.
The owner's placeholder test results are not acceptance evidence. No application
or test migrations, application-data changes, worker starts, external calls or UI
modifications occur in this step. Webpack is verified in a separate /tmp source
snapshot so the owner's running Next.js dev output is not disturbed.

Prepared commit: `feat(github): expose authorized operational health summaries`.
Step 4 and M3.5 acceptance remain pending; wait for owner commit confirmation.

## M3.5 step 4 — administrator panel health display (2026-11-17)

Confirmed clean feature branch at fb5d5b0. Added a scoped health component inside
the existing GitHub event-processing panel with existing buttons/design tokens;
no separate dashboard or assistant/global layout changes. A client-side contract
validates the Step 3 response and strips unused fields. Friendly worker labels
separate idle/active, unavailable, bounded, insufficient, disconnected and archived
evidence. Delivery queue/scheduling, retry/dead-letter outcomes and workflow counts
are shown independently, with locale-aware timestamps and compact disclosures.
The existing misleading claim that GitHub can never change status is corrected:
linking itself does not mutate tasks; explicitly confirmed workflow rules can.

GET-only polling every 30 seconds respects foreground visibility and stops after
access denial. Cached data is not treated as authorization: it stays hidden until
mount-time verification, is scoped by workspace/project/connection and is removed
from view on role loss or 401/403/404. Mismatched response scope is rejected.
Snapshot age is updated by timers/focus/request completion; snapshots older than
90 seconds, refresh failures or device-clock differences cannot appear as current
healthy evidence. Transport errors are generic; diagnostic copy is allowlisted by
code rather than rendering arbitrary returned messages or credentials.

Full unit suite: 375 passed in 41 files, including 22 new health UI cases and one
additional full-page member-visibility regression. Existing explicit retry,
enrichment and repository connection/disconnect tests remain passing. Browser
journey added for both Playwright projects, dark/light, 1440/1024/768/390 widths,
keyboard refresh, sanitized failure and no GitHub writes. Discovery is not browser
execution; no screenshot/visual or real-DB acceptance is claimed here. Exact
static/build/format results and local steps are in VERIFICATION.md. Production
build uses a temporary credential-free source snapshot to preserve dev output.

No backend authorization, schema, worker, automation rule or domain mutation service
is changed. No live GitHub action or application data mutation is performed.
Prepared commit: `feat(github): display operational health in existing panels`.
Stop for owner commit confirmation before step 5; M3.5 remains incomplete.

## M3.5 step 5 — explicit repository connection diagnostics (2026-11-17)

Confirmed e3f6ecf on the feature branch with a clean tree. Owner-reported local
application evidence: worker-health migration applied, schema current, working
healthy-idle UI and zero pending/failed/dead-letter deliveries. This is owner
manual evidence, not agent-executed PostgreSQL/browser test results. No existing
application records or live GitHub credentials are used during implementation.

The new same-origin POST action derives the authenticated actor and project from
the authorized workspace connection, accepts no identity overrides, and uses only
the requesting administrator's OAuth credential. If enrichment is configured by
someone else it reports inconclusive and requests that authorizer's check; no
fallback credential is silently used. Missing accounts, unreadable encryption,
inactive scope, invalid identity, missing permissions and provider failures have
sanitized diagnostics. Two bounded GETs at most check account authentication and
repository metadata/admin evidence; all enrichment/webhook capabilities are not
claimed verified. HTTP 401 is authorization rejected with unresolved cause, not
fabricated separate expired/revoked conclusions: no expiry metadata is stored.

Local authorization and credential/configuration fingerprints are rechecked between
requests and before publication; positive stale evidence cannot silently retarget
or reconnect a repository. External reads never hold long database transactions.
Domain records remain unchanged. Existing per-admin RateLimit budgets and shared
credential cooldown metadata are the only runtime database writes. Observed header
timing is distinguished from recorded local cooldowns; no invented worker fallback
retry time is presented as provider evidence. Existing worker behavior is unchanged.

The existing event-processing administrator panel gains an explicit check button,
loading state, source/time/result, safe guidance and deliberate retry. Mounting,
health polling, reconnecting a browser or returning to the scope does not run a
check. A changed enrichment setting clears the local diagnostic. No raw error,
token, observed private repository metadata or another authorizer's identity is
returned or rendered. Results are ephemeral, not durable validation grants.

Executed unit/HTTP/UI suite: 417 passed in 44 files (24 service, 3 route, 15 UI
cases added). Eight new real-DB cases are written but not run here. Existing
browser journey adds an explicit mocked revalidation step; two configured cases
are discovered, not executed or live GitHub acceptance. Static, formatting and
isolated production build results/local commands are in VERIFICATION.md.
Prepared commit: `feat(github): add explicit connection revalidation diagnostics`.
No push, merge, worker start, live OAuth action, application migration, rule edit
or DEV-002 change occurred. Stop for the owner commit before step 6.

## M3.5 step 6 — proposed retention impact reports (2026-11-18)

Confirmed clean feature branch at 09a32aa. Owner reports local revalidation and
idle/unavailable monitoring accepted, with repository identity/automation unchanged.
These owner observations are recorded separately from automated suite results.

Added owner/admin project-scoped retention GET and an explicit report control in
the existing GitHub processing panel. Proposed 7/30/90-day windows are ephemeral,
not configuration changes. Reports contain counts, age ranges/bases, primary
preservation reasons and overlapping downstream-reference counts for seven record
categories. Processing state is part of delivery receipts, not a fabricated second
queue table. Evidence ages use observation timestamps because evidence rows have
no independent created timestamp. Current/disconnected connections are included.

The conservative integrity policy preserves replay receipts, all provenance/task
associations and execution/idempotency history. Pending/running/failed/unresolved
records are not candidates. Only older terminal COMPLETED/STOPPED worker signals
may qualify hypothetically, retaining the latest heartbeat/past evidence and latest
poll/progress timestamps for each connection/mode. No cleanup approval or execution
is provided, and no storage-savings estimate is invented.

Queries use a consistent UTC DB clock/RepeatableRead snapshot and explicit read-only
transaction, statement timeout and transaction timeout. Metadata is capped per
category at 10,001 matched rows; over 10,000 returns incomplete/unknown counts and
no eligibility conclusions for that category. The application never loads payloads
or raw record lists into memory. Existing scoped/FK indexes support lookups; actual
query plans/performance still need local PostgreSQL verification. No universal
constant disk-scan cost is claimed. Timeouts fail safely without partial reports.

441 unit/HTTP/DOM cases pass in 47 files (24 new: 13 service/policy, 3 route, 8 UI).
Eleven PostgreSQL cases cover actual SQL boundaries/relationships, isolation,
large-scope limits and read-only enforcement but are unexecuted. The extended
Playwright journey discovers two cases only; screenshots/responsive acceptance
remain pending. Exact static/build results are in VERIFICATION.md.

No live connection, rule, task, DEV-002, webhook, worker, migration, retention data
or external service action occurred. Source changes are only the read-only report,
its panel integration, tests and documentation. Prepared commit:
`feat(ops): add read-only retention impact reports`. Stop before step 7 pending
owner commit confirmation; M3.5 acceptance remains open.
