# Current follow-up: agent context and provider efficiency

This follow-up changes reasoning, tool execution and verified-data wording only.
**No page layout or stylesheet was changed.** The earlier UI stabilization audit is
retained below as historical documentation.

## Why clarification and redundant reads happened

The previous system instruction explicitly told workspace conversations to ask for
a project when none was identified. It supplied the workspace and pinned scope but
no authorized active project catalog, so it could not infer that Devflow was the
only active project. Each model read was independent; equivalent reads had no reuse
mechanism. A workspace personal query followed by a project personal query therefore
consumed extra database work, model rounds and context before finding the same zero
assigned matches. This did not indicate missing tasks: unassigned records are not
assigned-to-user records.

The configured organization's actual RPM/TPM/daily limits were not probed. Avoidable
rounds and context size were confirmed in code, not proven to be the exact quota
bucket responsible for the reported 429. No live usage values are claimed.

## Current scope defaults and execution

Each new run rechecks membership and loads an active, authorized project catalog:
IDs/names only, first 25 plus exact name/established-ID lookups when needed, and an
exact count. A partial catalog is marked incomplete; one listed project is never
mistaken for a sole project unless the exact total is one. Duplicate names require
clarification. No project names/descriptions are cached across users or runs.

| Request in a workspace conversation                 | Interpretation                                                                                                              |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| My assigned tasks                                   | Assigned to the session user across all active workspace projects, unless an explicit project name narrows it               |
| My tasks / My current tasks / What am I working on? | Unfinished assigned work in the established or sole active project; otherwise unfinished assigned work across the workspace |
| All project tasks                                   | Established project, otherwise sole active project; ask/use the agent when no unique project is known                       |
| All workspace tasks                                 | All active authorized projects, regardless of a prior project hint                                                          |
| Unassigned tasks                                    | No assignee, using a named/established/sole project when available, otherwise workspace scope                               |
| Project Devflow after a recognized task question    | Reuse that task intent with the uniquely resolved authorized project                                                        |

Pinned project conversations always remain pinned, including assigned queries. An
explicit workspace request there explains that a new workspace conversation is
needed. Project names resolve case-insensitively against authorized metadata; unknown
or duplicate names never fall back silently to another project. Completed work is
included in assigned/all views unless unfinished/current was requested. Creator
history remains unsupported. Project selection hints come from relevant user turns
or the latest authorized project/task read, and are revalidated each run.

A deliberately narrow allowlist recognizes these phrases and the existing task-view
chip prompts. It rejects extra filters, mutation instructions and complex/mixed
requests, which continue through the agent. Recognized and resolved reads call the
same `readAgentTool(listTasks)` service, preserve the full audit event, use the same
run claim/expiry/idempotency fencing, and save **no proposals**. They make **zero
provider calls**. Results are labeled **DevFlow database summary; no AI-generated
narrative**, state the default interpretation, render actual task records and show
matching totals/offset/completeness. Empty assigned results may include a separately
labeled, authorized project-context page; unassigned work is never labeled personal.

These verified reads can be submitted while Groq is cooling down. Client recognition
only controls button availability; the server resolves current catalog/authorization
again. Model-powered requests still respect the unchanged cooldown. Missing provider
configuration retains its existing setup state; this is not a simulated AI fallback.

## Read reuse and context limits

- Reuse exists only in a single `runAgentLoop` invocation; no cross-turn/user/workspace
  data cache. Read argument defaults are normalized, including optional false flags.
  Different scopes, assignees, projects and pagination remain distinct. Workspace and
  project views are not blindly coalesced, even if their present records happen to match.
- A cache hit rechecks current workspace membership and the referenced projects'
  active/workspace/pinned boundaries. If projects become unavailable, a fresh read
  supplies the current result/error. Gateways without that hook do not reuse results.
- Optional `fresh=true` on the four read tools bypasses reuse. Each write preparation
  clears prior read reuse; preparation/execution still captures current server versions.
  The registry remains exactly eight tools. Failed reads are not cached.
- Every call still has an audit event. Reused events retain the full result and a
  source-call marker. The model receives a reference to its earlier same-run result,
  avoiding duplicated task arrays in context. No full audit/proposal record is replaced.
- The system instructions are consolidated; actor identity appears once, project
  metadata contains only IDs/names, and the listTasks description is shorter. Up to
  six recent paired turns fit a 16000-byte history budget with answer excerpts up to
  3000 characters. Excerpts/older omitted turns are explicitly marked; the full stored
  conversation and immutable previews are unchanged. Last task pagination metadata
  is supplied separately, so the model need not re-query a first page to find nextOffset.

Freshness is scoped: default reuse is a short per-run view, not a promise of observing
concurrent external edits. Request `fresh=true` when those matter; every later user
turn starts a new cache, and proposal safety always uses fresh server checks.

## Safe provider diagnostics and quota limits

Set server-only `AI_DIAGNOSTICS=1` to enable aggregate console events (default off;
example configuration added). Logs include process request number, model-round/tool/
reuse counts, message and payload sizes, HTTP status, numeric request/token limit and
remaining headers, parsed advertised retry deadline, and reported prompt/completion/
total token usage when present. No prompts, answers, task titles, user/workspace IDs,
provider URLs, API keys or raw arbitrary headers are logged.

[Groq's rate-limit documentation](https://console.groq.com/docs/rate-limits) describes
organization limits and request/token headers. Available headers may identify an
exhausted bucket; they do not always identify RPM versus TPM versus daily quota.
Counters are diagnostic, not a distributed limiter. Existing 429 classification,
Retry-After parsing, local cooldown and **zero automatic retries** remain intact.
Recognized database-only questions use no Groq quota. Other requests remain dependent
on actual account/organization/model quota and provider availability.

After a provider failure, the existing failure state and actual tool records remain
separate from any answer. Verified table text now names its project/workspace scope,
matching offset and complete/partial status. No layout change or invented narrative.

## Verification for this follow-up

- **172 tests passed in 15 files**; full/core TypeScript, ESLint, webpack production
  build and changed-file formatting pass. Full-repo formatting retains the previously
  documented unrelated/generated differences.
- Coverage adds narrow intent/defaults, explicit project names and prior selection,
  partial catalogs/duplicate names, scoped read reuse/freshness/invalidation, correct
  pagination, revoked membership/archive guards, bounded history, zero-provider task
  execution, safe logging and existing rate/partial-result/approval regressions.
- **25 database integration tests and six browser cases discovered, not executed.**
  The new real-database routing fixture verifies workspace assigned/all, explicit
  names and selected-project follow-up with zero provider invocations. The earlier
  contextual fixture now explicitly expects zero provider calls on a simple request.
- No live Groq call, actual token measurement, database reset/migration, new dependency
  or Milestone 3 work. Known socket/listen/browser restrictions were not retried.

Local commands (existing server environment and a distinct `_test` DB):

```bash
pnpm typecheck
pnpm typecheck:core
pnpm lint
pnpm test
pnpm build:webpack
pnpm db:prepare:test
pnpm test:integration
pnpm test:e2e --reporter=list,html
```

In the running app, test the table above in workspace and pinned-project conversations,
including one project, multiple projects, duplicate names, empty assignments and a
second member's private history. With diagnostics enabled, recognized task phrases
should emit a verified-read event with zero provider rounds; complex questions should
show bounded model usage and preserve real data if 429 occurs. Never exhaust a real
production quota intentionally. UI visual acceptance from the prior repair remains
an independent open gate; this follow-up did not redesign the page.

---

# AI Assistant — current behavior and verification

## Stabilization repair (2026-11-13)

Source repairs and available automated checks are complete; **visual acceptance is
incomplete**. No supplied screenshot files were found in the repository. Browser
inventory reports `The browser access host is unavailable`. The reported screenshot
defects informed the audit, but no rendered page, contrast or screenshot comparison
was verified here. Do not substitute the production build or jsdom for that gate.

### Structural causes and layout ownership

The old shell used normal document flow while chat independently imposed
`min-height: 640px`, viewport-offset heights, `overflow: clip` and nested scrolling.
Three stylesheets also supplied competing transcript/composer/history rules. Headers,
scope explanations, reports and decorative footer consumed additional page height.
At narrower breakpoints, history became another row above that already tall chat.
Long titles wrapped without a line limit. These source constraints explain the risk
of nested scrolling and clipped controls; pixel-level defects remain unverified.

The repair replaces those conflicting rules instead of adding another override layer:

- The Assistant-only shell is a viewport-height flex column. Its existing global
  top bar retains its real height; content, view, manager frame and workspace inherit
  remaining space with `min-height: 0` / `min-width: 0`. No header-offset calculations
  or minimum chat heights remain. Other app pages retain their existing shell/footer.
- `assistant-page.css` owns workspace layout. `agent-manager.css` owns proposal and
  artifact details; `chat.css` owns message/Markdown typography. Obsolete layout
  declarations and breakpoint overrides were removed from the latter two files.
- Desktop history has a 250–310px track, independent list scrolling, two-line title
  clamping, full title/accessible labels, selected state and a compact New Conversation
  button. At <=1100px, the existing Radix dialog supplies focus-managed history,
  Escape/close behavior and focus return instead of stacking history above chat.
- One compact conversation header contains title, scope/model disclosure and pane
  actions. Workspace details, creator limitations and immutable-scope switching are
  disclosed on demand. New scope selection never retargets an existing conversation.
- Messages use a centered column up to 940px. Short user bubbles size to their content;
  assistant prose, verified data and compact tool disclosures share an alignment.
- The message list is the conversation scroll region. The composer is a sibling,
  not sticky/fixed inside a competing scroll container. It starts at 40px, measures
  multiline content including borders, and caps at 144px before scrolling input text.
  Send stays aligned, Enter inserts newlines, Ctrl/Cmd+Enter submits and the existing
  synchronous submission guard prevents duplicate requests.
- Plans & reports occupy a secondary pane in the same workspace. Switching panes
  keeps chat mounted; Quick Drafts also keeps the selected conversation mounted.
  The decorative page footer is omitted on this workspace; global branding/navigation
  remain. There is no fixed footer or composer-position hack.

Conversation titles were already based on the first submitted message. Suggested
prompts only fill the composer. Titles now normalize whitespace before the existing
100-character cap. A conversation that changes topic may legitimately retain its
first request's title; no old conversations were renamed or migrated.

### Provider errors and retry policy

HTTP 429 is handled separately from credentials, request rejection and provider 5xx
errors. No upstream error body, credential or arbitrary response header is exposed.
The implementation follows the documented timing signals in
[Groq's rate-limit documentation](https://console.groq.com/docs/rate-limits):

- `Retry-After` supports seconds (including fractional values) and HTTP dates.
- If it is absent/invalid, known exhausted request/token buckets may supply Groq
  reset durations. Non-exhausted buckets do not invent a wait. If multiple known
  buckets are exhausted, the later reset is used.
- Valid delays become absolute deadlines and safe HTTP `Retry-After` responses.
  Missing/invalid timing produces clear quota/rate-limit advice without a made-up ETA.
- **Automatic retries: zero.** Unknown transport completion/billing and multi-step
  proposal staging make implicit replays undesirable. A bounded, credential-hash-keyed
  process-local cooldown suppresses further fetches before a known deadline. Agent
  and Quick Draft adapters share that backoff; no raw key is retained in the cache.
- Persisted failure text retains a known deadline; chat disables sending until it
  passes and shows the actual local time. Request UUIDs correlate a failed run with
  its delivery error, avoiding duplicate error panels. Run UUIDs stay private and
  are not displayed as ordinary content. Legacy misleading 429 text receives a safe
  display-only explanation; stored historical errors are not rewritten.

The backoff is not a distributed quota manager. Other processes, restarts or already
in-flight requests can still receive 429; a retry deadline is not a success guarantee.
Unknown delays require an explicit later user attempt. Provider settings and Groq's
`openai/gpt-oss-120b` transport remain server-configured and unchanged.

### Partial results and model context

Successful tool records are persisted before the next provider call. A later failure
keeps the run FAILED and does not fabricate/store a completed answer or save new
approval proposals. The UI shows the failure, then the latest successful task read
as **Retrieved task data**, with assignment/project scope and partial-page counts.
Earlier events remain in collapsible history. Prepared writes from an interrupted
run are labeled unsaved for approval; they expose no approval action.

`agent-model-results.ts` derives a compact model-facing view after audit persistence:

- Task pages retain reference, title, friendly status/priority/assignee, due date,
  internal task/project IDs where needed for later tools, a page-level project-name
  map and pagination. Duplicate relation/label envelopes and creation timestamps are
  omitted. `getTask` retains description, version, scheduling and authorization-relevant
  reference data for safe proposal preparation.
- Empty personal items remain empty. A separately labeled project-context page appears
  once; it is never relabeled as assigned work or duplicated in another envelope.
- Write-tool replies acknowledge preparation without resending the full input,
  before/after payload and version map that are already retained for the immutable
  UI preview. Full proposal payload/hash calculation and execution are unchanged.
- Project summaries omit repeated sprint task arrays. Previous answer excerpts are bounded
  to 3000 characters, with whole-turn history kept within a 16000-byte budget and
  explicit excerpt/omission notices; full
  text remains in history. The existing total context/tool/round bounds still apply.
- A too-large model result becomes a complete narrowing-request error. It no longer
  replaces or truncates the original audit record.

The representative task fixture asserts compact JSON is <65% of the full fixture's
size. This is a regression guard for that fixture, **not measured Groq token savings**.
Actual token/quota behavior and live instruction following require local verification.

## Task semantics and security retained

`listTasks.scope` remains `all` (default), `mine` or `unassigned`. `mine` resolves the
session actor's assignee ID server-side. Explicit assigned-only requests omit context;
ambiguous requests may opt into `includeProjectContext=true`. On an empty filtered
personal result, only an already-known authorized active project can supply a separate
page (<=25 rows), exact project total and unassigned total. There is no automatic
unrelated workspace fallback. `unfinished=true` excludes DONE; zero matching unfinished
assignments must not be described as zero assignments overall. `hasMore`/`nextOffset`
refer to the same filtered predicate as the total. Archived projects are excluded.
Creator information is not reliably stored; created-by-me is explicitly unsupported.

The reported historical three tasks were unassigned, so zero assigned matches was
expected. No current database count is asserted here. The shell's selected project
initializes new drafts; persisted conversations keep their actual immutable scope.

The eight tools, workspace membership/project checks, private history, Origin/body
validation, audit logs, task versions, preview hashes, expiry, explicit decisions and
idempotent receipts remain intact. No domain operation is auto-approved or executed.
No new dependency, endpoint or database migration is required by this repair.

## Markdown and diagnostics

The existing Marked-token-to-React renderer is preserved: GFM headings/lists/tables,
checklists, code, quotes, links and line breaks. It never calls an HTML parser or
`dangerouslySetInnerHTML`; raw HTML, embeds, remote images and unsafe schemes are
blocked. External links use protective attributes. Verified DEV references resolve
against authorized snapshot and conversation scope before the existing task callback.

JS/TS/JSX/TSX and JSON/JSONC fences use js-tokens lexical spans; other languages remain
readable, labeled and copyable plain code. Tables/code scroll within their own regions.
Renderer dependencies from the earlier UX milestone remain marked 16.4.2, entities
4.5.0 and js-tokens 4.0.0; jsdom 22.1.0 is test-only. No package was added in this repair.
Tool JSON stays inside **Developer Details**, recursively redacted for common secret
keys; display redaction never changes persisted records. Quick Drafts retains all six
read-only actions, safe Markdown/copy, project context and workspace reset behavior.

## Actual verification

- **144 tests passed in 13 files**, including provider 429/date/duration/cooldown,
  no automatic retry, HTTP headers, compact results/audit separation, partial failure,
  title submission, history dialog, pane switching, composer growth, conversation
  retention, safe Markdown/navigation, approvals and Quick Draft regressions.
- Full/core TypeScript, ESLint, Prisma generation, webpack build and changed-source
  formatting pass. Whole-repo formatting still reports seven unrelated/generated
  files listed in `UPGRADE_REPORT.md`; these were not reformatted.
- **24 integration tests and six browser cases discovered, not executed.** The new
  real-DB fixture covers late 429 persistence without task/proposal writes. Browser
  fixtures cover late 429, history dialog, report pane and page overflow/composer
  visibility at 1440, 1024, 768 and 390px, with light/dark screenshot instructions.
- No screenshot captured, real database reset/migration, live Groq request, new package
  or Milestone 3 work. Known PostgreSQL socket/listen sandbox restrictions were not
  retried; browser inventory independently confirmed unavailable visual access.

## Local verification and visual acceptance

From the normal terminal, retaining the existing server-only Groq variables:

```bash
pnpm typecheck
pnpm typecheck:core
pnpm lint
pnpm test
pnpm build:webpack
pnpm db:prepare:test
pnpm test:integration
pnpm exec playwright install chromium
pnpm test:e2e --reporter=list,html
pnpm dev
```

`db:prepare:test` requires a distinct database ending in `_test` and applies existing
migrations without resetting it. Never point tests at the app DB. Playwright starts
its own isolated server on port 3100; keep it free. See `VERIFICATION.md` for setup.

At **1440, 1024, 768 and 390px**, in **both themes**:

1. Confirm the document stays still while messages scroll; composer/send remain
   visible. Inspect long tables, long code lines, multiline input and soft keyboard.
2. Inspect sidebar title truncation/full labels; open narrow-screen history by keyboard,
   select a conversation, Escape/close and check focus return with no keyboard trap.
3. Inspect header scope/model, scope disclosure/new-conversation action and the
   Plans & reports pane. Return through Quick Drafts and confirm the chat is retained.
4. Ask ambiguous personal, assigned-only, unassigned, pending and all-project questions.
   Compare actual records and project boundaries; created-by-me must explain its limit.
5. With a controlled provider fixture, return 429 after a real successful task read.
   Confirm one failure, verified data, collapsed audit, no invented answer or approval
   controls for unsaved drafts. Test known and unknown Retry-After, then refresh.
6. Verify live Groq separately, including shared organization quota behavior. Never
   intentionally exhaust production quota just to test this fixture behavior.
7. Review saved desktop/mobile screenshots against the supplied bug report. Capture
   additional soft-keyboard/contrast checks manually. Approve/reject separate proposals
   and check stale versions with the existing regression workflow.

**Do not close visual acceptance until these rendered-page checks actually execute.**

## Verification repair — saved Fedora failures (2026-11-13)

This repair leaves the Assistant layout, agent routing, provider transport and all
approval endpoints unchanged. The six saved `test-results/` traces and accessibility
snapshots were inspected, along with two extracted desktop screencast frames. These
are original failure artifacts, **not screenshots of the repaired application**.

- Registration returned HTTP 201. The desktop case exhausted its five-second heading
  assertion during cold navigation/workspace loading; the saved page showed
  `Loading workspace`, rather than a registration error. E2E registration now asserts
  201 and awaits the actual successful workspace snapshot before testing the dashboard.
- The rendered integration button is named `AI assistant BETA`. The exact-name
  `AI assistant` test selector was outdated; it now allows the existing badge.
- On mobile reload, the trace records `isVisible` for `Open conversations` followed
  immediately by the history-item click, with no opener click. The conditional check
  could run before the Assistant mounted. The helper now awaits the manager region
  before checking the responsive opener. History remains in the existing Radix dialog.
- Navigation helpers await the mounted navigation and avoid toggling an already open
  mobile menu. Context tests explicitly open the existing context disclosure when
  interacting with its scope selector.
- Task creation snapshots show native, correctly named `Priority`, `Assignee` and
  `Status` comboboxes. Tests now use their accessible roles and names; exact label-text
  matching was unreliable for wrapping labels containing option text. No form control
  behavior or accessible labels were changed.

Playwright's server explicitly clears `AI_API_KEY`; AI fixtures remain intercepted
and no live Groq request is needed. See the latest `VERIFICATION.md` section for the
executed checks and unresolved real-database/browser execution gates.
