# Agentic AI project manager — Milestone 2

## Setup and use

Apply the additive migration and regenerate the client in your normal local terminal:

```bash
pnpm db:migrate
pnpm db:generate
```

Set server-only `AI_API_KEY`, `AI_BASE_URL` and `AI_MODEL` in `.env`, then restart.
The existing model default is retained. The provider must support Chat Completions
function tools. HTTPS is required except for a localhost HTTP provider. Redirects
are refused so credentials cannot be forwarded to another host. No credentials
appear in browser responses. The configuration endpoint reports setup state and
model name; it does not test connectivity. No key means a clear setup state and 503
for agent requests, never a simulated response.

Open **AI assistant → Project manager**. Start a workspace or project conversation.
Its scope is fixed at creation; start another conversation to change it. Prompts
cover Q&A, descriptions, child tasks, sprint planning, progress summaries, overdue
work, priorities, dependency risks, workload-based assignment suggestions and weekly
reports. Suggestions use actual authorized records; the model can still make
mistakes, so review its narrative and proposed changes. Existing **Quick drafts** and the six-action `/api/ai` text endpoint remain available.

Sending a request stores conversation/audit records and proposal drafts. It does
**not** create/update project tasks, save a sprint or publish a report. Each proposed
domain write has its own complete preview and **Approve** / **Reject** controls.
Read the before/after values, project/task identity and report source snapshot.
Approval applies exactly that stored action; chat text such as “approve everything”
cannot approve anything. There is no automatic or batch approval.

Approved sprints and reports appear below the conversation, shared with authorized
workspace members. Task receipts open the normal task dialog. Child tasks are
ordinary project tasks with a parent; task details show parent/subtask relationships.
Sprints retain task title/status/version baselines. They cannot assign one task to
overlapping sprint intervals. Sprint/report editing and deletion are outside this
milestone; saved report/sprint artifacts are preserved.

## Architecture and authorization

- `src/lib/agent.ts`: strict Zod inputs, the eight tool definitions, shared DTOs and
  budgets. Tool schemas do not accept workspace/user IDs, approval flags or client
  versions. The server supplies authorization and captures versions from records.
- `agent-provider.ts`: server-only bounded OpenAI-compatible adapter. It follows
  the documented [function-calling protocol](https://developers.openai.com/api/docs/guides/function-calling)
  with assistant tool calls and matching tool-role results. Tool definitions use
  optional parameters for provider compatibility; strict server-side Zod validation
  remains authoritative, regardless of provider behavior.
- `agent-loop.ts`: bounded orchestration with a read-and-preview gateway. There is
  no domain mutation or approval method in this gateway. Unknown tools, invalid
  arguments and scope violations become safe tool errors, with no fabricated data.
- `agent-tools.ts`: authorized project/task reads, preview preparation and a distinct
  executor called only by the approval service. Membership is rechecked on each tool
  step and approval. Project-scoped conversations cannot read or propose writes in
  other projects, including projects the actor could access in a different conversation.
- `tasks.ts`: shared task writes used by both the normal API and approved AI actions.
  Project locks, version checks, date/assignee/label validation, fractional board
  order, activity and assignment notifications are preserved.
- `agent-manager.ts`: private persisted conversation/run history, request claiming,
  audit events, immutable proposals and transactional approval receipts.

Conversations, their runs, tool logs, proposals and receipts are accessible only to
their owner while they remain a member of the scoped workspace. Other members,
including administrators, cannot read or approve another actor's conversations.
Approved tasks/sprints/reports are normal authorized project data. Public user fields
in model context are limited to member IDs/names; session hashes, passwords, tokens
and API keys are not selected or sent by tools. Model text and project records are
treated as untrusted data, rendered as text, and never evaluated as HTML or code.

## Approval, idempotency and concurrency

Each proposal stores a server-normalized payload, full preview, canonical SHA-256
digest, expiry, state and eventual result. The decision endpoint accepts only
`decision` and `previewHash`; it cannot accept replacement task fields or arguments.

On approval, the server locks the authorized proposal row under READ COMMITTED,
rechecks membership, verifies payload/preview integrity and validates the expected
hash. It then locks the active project, revalidates related records and versions,
executes the shared domain service and writes the APPLIED receipt **in the same
transaction**. Failures roll back the domain write and receipt. A repeated approval
returns the saved result, even after expiry, without executing again. Rejecting a
proposal is terminal. Expired pending proposals cannot execute. Stale updates and
sprint baselines return 409 and need a new preview. Other related-record/archive
changes can return 400/404/409; none cause silent overwrites.

Conversation row locks serialize turn claiming. Unique `(conversationId, requestId)`
keys bind request UUIDs to their original prompt; changing a prompt with the same key
is rejected. A SQL partial unique index also permits only one RUNNING turn per
conversation. Active turns reject competitors. Expired interrupted runs are marked
failed when a new request starts; late provider results cannot save proposals after
the run fence fails. Tool events persist as steps finish, including those preceding
a later provider failure. No database transaction spans a provider network request.

Different proposals are independent approvals. If two previews update the same
task, applying the first can stale the second. There is no hidden cascading apply
or compensation. Concurrent execution guarantees require the database-backed tests
listed below; mocked unit tests alone are not evidence of live transaction behavior.

## Budgets and data definitions

- Six model rounds, 16 tool calls, six write proposals per turn; 80-second overall
  signal, 25-second provider-call timeout, 120-second run lease, 30-minute proposals.
- Provider output is capped at 256 KB; context at 160,000 characters; tool results at
  32,000 characters. Oversized results produce an explicit narrowing error, not
  malformed/truncated JSON. Limits can cause a request to fail without saved proposals.
- Task/project queries use pagination with explicit totals and stable ordering;
  maximum page size 50. Descriptions/comments and related lists have declared caps.
  `DEV-123` references resolve only inside the authorized conversation scope.
- The provider receives up to ten previous turns and action receipts. Conversation
  lists show the latest 50, a conversation view its latest 30 turns, and artifacts the
  latest 20 of each kind. Older records remain stored; older-history pagination is
  a future improvement. Failed request text and completed tool events remain visible.
- Workload means current unfinished task counts per assignee in the queried project.
  It is not skills, availability, effort, utilization or measured sprint velocity.
- Report source snapshots store an explicit `asOf`, reporting interval, current
  status counts, tasks created in the inclusive interval, currently DONE tasks whose
  current `completedAt` falls in that interval, and currently overdue unfinished work.
  Deleted/reopened historical states are not reconstructed. Overdue here means due
  timestamp before the snapshot instant; the roadmap's day-based warnings retain
  their existing UTC-calendar-day definition. Narrative is an AI draft, not a
  calculated metric or a guarantee of factual accuracy.
- Sprint date ranges must be ordered and at most 56 days apart, with 1–100 distinct
  existing unfinished tasks from the same project. Task versions/statuses are checked
  again on approval; dates and memberships are saved only after approval.

## API additions

All routes require authentication and `?workspaceId=…`. Mutations retain exact
Origin checks, bounded JSON, Zod validation and existing write limits. Turns have an
additional per-user quota. Responses expose only authorized public data.

| Endpoint                             | Method     | Purpose                                                       |
| ------------------------------------ | ---------- | ------------------------------------------------------------- | ----------------------- |
| `/api/ai/config`                     | GET        | Provider configuration state, no credentials                  |
| `/api/ai/conversations`              | GET / POST | List own conversations / create `{title, projectId?}`         |
| `/api/ai/conversations/:id`          | GET        | Own conversation, turns, tool activity, previews and receipts |
| `/api/ai/conversations/:id/messages` | POST       | `{requestId: UUID, prompt}`; run reads and stage previews     |
| `/api/ai/proposals/:id/decision`     | POST       | Explicit `{decision: "approve"                                | "reject", previewHash}` |
| `/api/ai/artifacts`                  | GET        | Authorized saved sprints/reports; optional `projectId` filter |

The tool registry is exactly `listProjects`, `getProject`, `listTasks`, `getTask`,
`createTask`, `updateTask`, `createSprint`, `generateReport`. There are no delete,
approval, environment, network, filesystem, membership or arbitrary-query tools.

## Migration and verification

`202611130002_agent_manager` adds nullable parent-task links, seven AI/planning tables,
status enums, indexes, scoped foreign keys, dates/receipt constraints and a partial
unique active-run index. It does not reset, drop or reseed existing data. Historical
completion/sprint metrics are not backfilled or invented. Preserve the SQL-managed
partial index when authoring future migrations.

Available checks include Prisma validation/generation, TypeScript, ESLint, mocked
provider/orchestration/approval tests, shared task regression tests, standalone
PostgreSQL schema assertions and the webpack build. No live provider calls are made
by unit or integration fixtures. The integration suite adds eight real-database
agent lifecycle tests with an explicitly stubbed provider; the browser suite adds
desktop/mobile approval UI coverage with explicitly intercepted AI responses.

Real database/API/concurrent execution and browser verification remain blocked by
the previously established sandbox restrictions and are **not claimed passed**.
No prohibited connection/listening attempts are repeated in Milestone 2. See
`UPGRADE_REPORT.md` for current counts and `VERIFICATION.md` for local commands.
Provider compatibility and output quality need a configured live provider check.
Milestone 3 is not implemented or started.

## Chat rendering follow-up

The Project manager now renders saved/new answers as safe GFM React components with
responsive tables, highlighted/copyable JS/TS/JSON fences, checklists and verified
DEV-reference navigation. Tool events are collapsed summaries with structured results
and optional redacted developer JSON. Proposal hashes and approval execution are
unchanged; exact preview text remains reviewable. Quick Drafts is preserved.

`listTasks` adds optional `scope` (`all` by default, `mine`, `unassigned`). Personal
ownership is resolved from the authenticated actor, never inferred from creation.
Authorized read results include friendly task/project/assignee/status/priority labels
while retaining internal IDs. The provider transport and existing Groq configuration
are unchanged. No migration is needed. See `AI_CHAT_UX.md` for dependency choices,
security boundaries, test results and remaining local verification.
