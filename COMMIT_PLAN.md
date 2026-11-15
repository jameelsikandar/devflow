# Proposed initial Git commit plan

**Status: the owner explicitly approved the eight-commit plan.**

The sequence below is authorized for execution. Repository findings and validation
results describe the planning/preflight snapshots; consult Git for actual execution
progress. Application source and migrations remain unchanged. The approved history
corrections in README.md, CHANGELOG.md and REPOSITORY_SETUP.md are applied before
committing.

## Repository findings

- Branch: `main`, with an unborn HEAD (zero commits) and an empty index.
- Current inventory: **199 untracked source/configuration/documentation files,
  44,595 lines**. The plan adds only this document and `docs/commit-plan.json`,
  bringing the eventual planned file inventory to **201**.
- There are 199 existing loose Git blobs, all matching the current candidate file
  bytes. There are no commit/tree objects, refs to prior commits, or remotes.
  Earlier staging created blobs; it did not recover historical source versions.
- No source, application configuration, schema, migration or test was edited during
  this planning task. No PostgreSQL command, live worker, rule enablement or GitHub
  request was executed. Original-file SHA-256 fingerprints were recorded to detect
  changes between this review and execution.
- Previous one-baseline/read-only-repository recommendations in README, CHANGELOG
  and REPOSITORY_SETUP describe the earlier preparation attempt. They will be
  corrected in the final documentation commit **after approval**, not silently
  treated as current Git state.

## Recommendation: eight current-state import commits

Use eight logical commits, including one separate **shared application assembly**
commit. All content is imported as it exists today. The sequence is a review aid,
not a claim that these source versions existed during the original milestones.
Use actual current commit dates and your real configured Git identity. No old
commits exist to rewrite, and none will be fabricated.

Each cumulative prefix was copied to an independent temporary directory, containing
only that prefix's selected files and a link to the installed dependencies.
**All eight prefixes passed standalone TypeScript.** No future untracked source
was visible to those checks. The existing generated Prisma client corresponds to
the identical full schema committed in step 1; no database was accessed.

**Important limitation:** commits 1–6 are dependency-complete TypeScript modules
and scaffolding, not complete runnable Next.js applications. The shell and catch-all
API cannot honestly appear earlier without importing every feature they reference
or changing the current source. The first full Next.js production build is commit 7.
Test/core-test/Playwright scripts are complete in commit 8. The full package manifest
is kept intact from step 1; its future script targets are not all present beforehand.
Do not interpret a TypeScript pass as runtime/database/provider acceptance.

If **every commit must contain a complete production-buildable application**, use
the three-commit fallback below instead. Seven independently runnable historical
milestone applications cannot be recovered safely from the current source.

| #   | Conventional commit message                                             | Files | Existing lines | Validation at this prefix                           |
| --- | ----------------------------------------------------------------------- | ----: | -------------: | --------------------------------------------------- |
| 1   | `chore: add project tooling and current database contracts`             |    25 |          8,672 | TypeScript passed                                   |
| 2   | `feat(core): add workspace and task management modules`                 |    26 |          1,779 | TypeScript passed                                   |
| 3   | `feat(roadmap): add Gantt timeline and dependency services`             |     3 |          1,415 | TypeScript passed                                   |
| 4   | `feat(ai): add project manager tools and chat components`               |    29 |          4,925 | TypeScript passed                                   |
| 5   | `feat(github): add repository connections and durable event processing` |    16 |          2,334 | TypeScript passed                                   |
| 6   | `feat(automation): add confirmed workflows and worker execution`        |    12 |          1,968 | TypeScript passed; worker compile passed            |
| 7   | `feat(app): assemble workspace routes and shared feature UI`            |    17 |          8,336 | TypeScript passed; complete production build passed |
| 8   | `test: add verification suites and implementation documentation`        |    73 |         15,166 | TypeScript passed; 326 unit tests passed            |

Line counts describe the original 199-file inventory; the two new plan artifacts
are included in commit 8's file count but excluded from existing-line counts.

## Shared-file decisions and dependency evidence

The inspected local import graph contains **439 edges** with no unresolved local
imports. The proposed grouping has **zero imports into a later commit**. This
includes type-only and dynamic imports as well as ordinary imports/CSS references.
Tests remain in commit 8 so their cross-feature imports and file-based migration
fixtures are available together.

| Shared file(s)                                         | Placement and reason                                                                                                                                                                                   |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| prisma/schema.prisma and all migrations                | Commit 1: the current Prisma models already span M1–M3.4; splitting the schema into invented earlier versions would rewrite source.                                                                    |
| src/lib/types.ts; src/lib/roadmap.ts                   | Commit 1: Task/Roadmap types and core scheduling validation share the entire existing roadmap contract/math file. It is not duplicated or partly staged.                                               |
| src/lib/server/tasks.ts; task-status.ts                | Commit 2: shared human task validation, status/completion semantics and version logic are core dependencies used by AI and automation later. GitHub link counts rely on the full schema from commit 1. |
| src/lib/server/http.ts; provider-rate-limit.ts         | Commit 2: the shared HTTP adapter imports the provider error type; delaying it until the AI commit would break core imports.                                                                           |
| src/lib/task-read-plan.ts                              | Commit 4: it imports AI view/chat presentation modules, so placing it in core would create forward dependencies.                                                                                       |
| src/lib/server/github-job.ts; github-worker-runtime.ts | Commit 6: the current job/runtime import automation planning/execution. Earlier queue/lease primitives are independently present in commit 5.                                                          |
| src/components/integrations.tsx                        | Commit 7: contains AI, GitHub and settings interfaces in one file. Importing it with only the AI files would miss GitHub dependencies.                                                                 |
| src/components/devflow.tsx                             | Commit 7: imports roadmap, all workspace views, task dialogs, AI and GitHub integration entry points.                                                                                                  |
| src/components/task-dialog.tsx; workspace-views.tsx    | Commit 7: depend on task GitHub activity and workflow settings, respectively, and include automation-aware activity rendering.                                                                         |
| src/app/api/[...path]/route.ts                         | Commit 7: imports core, roadmap, AI, GitHub and automation services. It must stay intact.                                                                                                              |
| src/app/globals.css and root entry points              | Commit 7: the styling and route/layout wiring cover the assembled application.                                                                                                                         |
| tsconfig.core.json, tests and test configs             | Commit 8: the core config names later modules/tests explicitly; DOM and API tests import shared assembled modules.                                                                                     |

## Migration ordering

All seven genuine migrations are committed together with their matching final schema
in commit 1. Git tree order does not execute migrations: Prisma uses the existing
versioned directory names. Preserve these files and checksums, in this order:

1. `202611120001_initial`
2. `202611130001_roadmaps`
3. `202611130002_agent_manager`
4. `202611130003_github_webhook_foundation`
5. `202611140001_github_processing`
6. `202611150001_github_workflow_definitions`
7. `202611150002_github_workflow_execution`

Committing migrations does **not** apply them. No database prepare/migrate/reset,
seed or integration test is part of preparing or executing this Git plan.

## Exact files per commit

Paths are literal repository-relative paths, not globs. No whole-directory staging
or interactive source-hunk reconstruction is required.

### 1. Project configuration and shared foundation

`chore: add project tooling and current database contracts`

Commits the final current schema and all seven migrations together. Includes the existing shared Task/Roadmap contracts without pretending they predate later features. Tooling and domain types compile; no Next.js application entry points exist yet.

```text
.env.example
.gitattributes
.gitignore
.prettierignore
.prettierrc.json
components.json
compose.yaml
eslint.config.mjs
next.config.ts
package.json
pnpm-lock.yaml
pnpm-workspace.yaml
postcss.config.mjs
prisma/migrations/202611120001_initial/migration.sql
prisma/migrations/202611130001_roadmaps/migration.sql
prisma/migrations/202611130002_agent_manager/migration.sql
prisma/migrations/202611130003_github_webhook_foundation/migration.sql
prisma/migrations/202611140001_github_processing/migration.sql
prisma/migrations/202611150001_github_workflow_definitions/migration.sql
prisma/migrations/202611150002_github_workflow_execution/migration.sql
prisma/migrations/migration_lock.toml
prisma/schema.prisma
src/lib/roadmap.ts
src/lib/types.ts
tsconfig.json
```

### 2. Core project management

`feat(core): add workspace and task management modules`

Adds authentication, authorized/versioned task services, shared status semantics, reusable UI and analytics modules. The generic provider-rate-limit error belongs here because shared HTTP error handling imports it. The source remains an unassembled set of modules.

```text
prisma/seed.ts
scripts/cleanup.ts
src/components/auth-form.tsx
src/components/common.tsx
src/components/kanban.tsx
src/components/palette.tsx
src/components/providers.tsx
src/components/ui/button.tsx
src/components/ui/dialog.tsx
src/lib/analytics.ts
src/lib/client.ts
src/lib/kanban.ts
src/lib/server/auth.ts
src/lib/server/crypto.ts
src/lib/server/db.ts
src/lib/server/env.ts
src/lib/server/errors.ts
src/lib/server/http.ts
src/lib/server/project-lock.ts
src/lib/server/provider-rate-limit.ts
src/lib/server/request.ts
src/lib/server/task-status.ts
src/lib/server/tasks.ts
src/lib/task-reference.ts
src/lib/utils.ts
src/lib/validation.ts
```

### 3. Roadmap and Gantt

`feat(roadmap): add Gantt timeline and dependency services`

Adds the roadmap component/styles and authorized graph/scheduling service. The whole shared roadmap math/validation file is already in commit 1 because types and core task validation depend on it.

```text
src/components/roadmap.css
src/components/roadmap.tsx
src/lib/server/roadmap.ts
```

### 4. AI assistant

`feat(ai): add project manager tools and chat components`

Adds the complete current AI orchestration, eight tools, approvals, read routing, Markdown renderer and chat components. The cross-feature integrations.tsx wrapper is deliberately deferred to application assembly.

```text
src/components/agent-manager.css
src/components/agent-manager.tsx
src/components/assistant-page.css
src/components/chat/ai-message.tsx
src/components/chat/chat.css
src/components/chat/code-block.tsx
src/components/chat/copy-button.tsx
src/components/chat/markdown.tsx
src/components/chat/task-results.tsx
src/components/chat/tool-activity.tsx
src/components/chat/use-chat-scroll.ts
src/components/chat/use-composer-size.ts
src/components/chat/verified-results.tsx
src/lib/agent-view.ts
src/lib/agent.ts
src/lib/chat-presentation.ts
src/lib/provider-failure.ts
src/lib/server/agent-approval.ts
src/lib/server/agent-context.ts
src/lib/server/agent-diagnostics.ts
src/lib/server/agent-instructions.ts
src/lib/server/agent-loop.ts
src/lib/server/agent-manager.ts
src/lib/server/agent-model-results.ts
src/lib/server/agent-provider.ts
src/lib/server/agent-tools.ts
src/lib/server/ai.ts
src/lib/task-read-plan.ts
src/types/js-tokens.d.ts
```

### 5. GitHub integration and processing primitives

`feat(github): add repository connections and durable event processing`

Adds OAuth transport, repository authorization, HMAC/replay handling, queue/lease primitives, enrichment, observations, task links and read-only task activity. The standalone worker job/runtime is deferred to commit 6 because the current versions import automation directly.

```text
src/components/github-processing.tsx
src/components/task-github-activity.css
src/components/task-github-activity.tsx
src/lib/github-task-activity.ts
src/lib/server/github-activity.ts
src/lib/server/github-enrichment.ts
src/lib/server/github-event-handlers.ts
src/lib/server/github-monitoring.ts
src/lib/server/github-processing.ts
src/lib/server/github-reconciliation.ts
src/lib/server/github-repositories.ts
src/lib/server/github-request.ts
src/lib/server/github-task-links.ts
src/lib/server/github-webhook.ts
src/lib/server/github.ts
src/lib/server/task-github.ts
```

### 6. GitHub rules, automation and worker wiring

`feat(automation): add confirmed workflows and worker execution`

Adds both M3.3 definitions/previews and M3.4 execution from the current snapshot. Includes job/runtime/CLI wiring and the example service here so the background worker import graph is complete. Worker compilation is available; it is not started.

```text
deploy/devflow-github-worker.service
scripts/github-worker.ts
src/components/github-workflow-settings.tsx
src/lib/github-automation.ts
src/lib/github-workflows.ts
src/lib/server/github-automation-monitoring.ts
src/lib/server/github-automation.ts
src/lib/server/github-job.ts
src/lib/server/github-worker-runtime.ts
src/lib/server/github-workflow-evaluation.ts
src/lib/server/github-workflows.ts
tsconfig.worker.json
```

### 7. Shared application assembly

`feat(app): assemble workspace routes and shared feature UI`

Adds intact entry points and files that combine core, roadmap, AI and GitHub features. This is the first complete buildable Next.js application. No synthetic editing of the catch-all router or shell into imagined earlier states is needed.

```text
src/app/api/[...path]/route.ts
src/app/api/avatar/[id]/route.ts
src/app/api/events/route.ts
src/app/api/github/callback/route.ts
src/app/api/github/connect/route.ts
src/app/api/github/webhooks/[connectionId]/route.ts
src/app/error.tsx
src/app/globals.css
src/app/layout.tsx
src/app/loading.tsx
src/app/login/page.tsx
src/app/not-found.tsx
src/app/page.tsx
src/components/devflow.tsx
src/components/integrations.tsx
src/components/task-dialog.tsx
src/components/workspace-views.tsx
```

### 8. Documentation and verification

`test: add verification suites and implementation documentation`

Adds all current tests, test configuration, isolated-database helper, technical documentation and these plan artifacts. Integration/API/DOM tests are deferred together because many import the assembled app or shared wrappers. No database tests are run as part of this plan.

```text
AI_CHAT_UX.md
AI_PROJECT_MANAGER.md
ARCHITECTURE.md
CHANGELOG.md
COMMIT_PLAN.md
GITHUB_INTEGRATION.md
PLAN.md
README.md
REPOSITORY_SETUP.md
UPGRADE_PLAN.md
UPGRADE_REPORT.md
VERIFICATION.md
docs/README_LEGACY.md
docs/commit-plan.json
e2e/agent.spec.ts
e2e/github-automation.spec.ts
e2e/github-workflows.spec.ts
e2e/helpers.ts
e2e/task-github.spec.ts
e2e/workspace.spec.ts
playwright.config.ts
scripts/prepare-test-db.ts
tests/agent-approval-service.test.ts
tests/agent-read-reuse.test.ts
tests/agent-reliability.test.ts
tests/agent-runs.test.ts
tests/agent-sprint-execution.test.ts
tests/agent-tool-authorization.test.ts
tests/agent.integration.test.ts
tests/agent.schema.sql
tests/agent.test.ts
tests/api.integration.test.ts
tests/chat-interface.test.ts
tests/chat-rendering.test.ts
tests/core.test.ts
tests/crypto.test.ts
tests/database-config.test.ts
tests/database-config.ts
tests/github-automation-monitoring.test.ts
tests/github-automation.integration.test.ts
tests/github-automation.test.ts
tests/github-enrichment.test.ts
tests/github-interface.test.ts
tests/github-monitoring.test.ts
tests/github-padded-reference.test.ts
tests/github-processing-interface.test.ts
tests/github-processing.integration.test.ts
tests/github-processing.test.ts
tests/github-reconciliation.test.ts
tests/github-repositories.test.ts
tests/github-request.test.ts
tests/github-task-links.test.ts
tests/github-webhook.test.ts
tests/github-worker.test.ts
tests/github-workflows-interface.test.ts
tests/github-workflows-server.test.ts
tests/github-workflows.integration.test.ts
tests/github-workflows.test.ts
tests/github.integration.test.ts
tests/request.test.ts
tests/roadmap-interface.test.ts
tests/roadmap.schema.sql
tests/roadmap.test.ts
tests/schema.smoke.sql
tests/task-github-interface.test.ts
tests/task-github.test.ts
tests/task-read-plan.test.ts
tests/task-services.test.ts
tests/transaction-abort.test.ts
tests/transaction-abort.ts
tsconfig.core.json
vitest.config.ts
vitest.integration.config.ts
```

### Planned documentation corrections in commit 8

After approval, update README.md, CHANGELOG.md and REPOSITORY_SETUP.md to describe
this approved logical current-state sequence instead of recommending one baseline.
Preserve their technical content and the earlier audit as historical context. Do
not invent commit dates, original milestone source states or acceptance results.
These are documentation-only corrections; application files remain byte-for-byte.
Mark this plan approved only after actual approval, retaining its planning context.

## Security and exclusions

- Stage only the explicit paths in the approved manifest, never `git add .` or `-A`.
- Keep `.env`, real environment variants, node_modules, `.next`, `.worker`, generated
  types/build metadata, reports/traces, local databases/dumps, backups and private
  credentials outside the index. `.env.example` is intentionally reviewed/included.
- SQL exceptions retain all migration source and the three SQL test source files.
- Review found no high-confidence private credential matches in the original 199
  candidates. Example/test literals were reviewed without printing secret values.
  Existing Git blobs matched only those current file bytes. No object deletion or
  metadata cleanup is needed or authorized.
- This is a worktree candidate review; the index is empty. Rescan changed files and
  privately review the actual staged diff before committing after approval.
- Do not start a worker, enable a live rule, contact a live provider, mutate a
  database, add a remote or push as part of organizing history.

## Verification actually performed for this proposal

- Each of the eight cumulative prefixes: standalone `tsc --noEmit --incremental
false -p tsconfig.json` **passed** in its own temporary copy.
- Prefix 6: worker `tsc -p tsconfig.worker.json` **passed**, compilation only.
- Prefix 7: `next build --webpack` **passed** with no real environment files copied.
- Prefix 8: **326 unit tests passed, 37 files**, with integration suites excluded;
  the complete production build also **passed**. This additionally validates the
  code/test-bearing states of the smaller three-commit fallback.
- Original 199 new-file diffs: no whitespace-check diagnostics.
- No Git staging, commits, PostgreSQL tests, migrations, browser journeys or live
  GitHub/Groq operations were performed during planning. No runtime/database
  acceptance is inferred from these compile/unit checks.

Do not validate intermediate commits against the full current working directory:
untracked future source would hide missing dependencies. Use independent copies or
clean archived commit snapshots, as done for this proposal. Regenerate the Prisma
client from commit 1's unchanged schema when preparing a fresh dependency install;
`prisma generate` is code generation, not a migration. Next type generation/full
app builds apply once the application assembly exists (commit 7 onward).

## Smaller alternative: three complete application commits

If complete-app buildability at every step takes priority over topic granularity:

1. `feat: import complete DevFlow application through M3.4`: the **exact union of
   commits 1–7 above**, 128 files. This is the first full working application state.
2. `test: add isolated regression and browser verification suites`: every non-Markdown
   file in commit 8 **except docs/commit-plan.json**, 59 files.
3. `docs: document architecture milestones and verification history`: the remaining
   commit 8 paths (all Markdown plus docs/commit-plan.json), 14 files.

The machine manifest lists each alternative's paths explicitly as well. This is
still not one all-files baseline, but the first application commit is necessarily
larger (29,429 existing lines). No app functionality is stripped to make fake earlier
checkouts. Choose either the eight-commit proposal or this fallback before execution;
do not mix the two sequences or manufacture older milestone states.

## Fedora commands — only after explicit plan approval

No write-permission probe was made: staging/committing is deliberately deferred,
regardless of sandbox capability. These commands can run in a normal local Fedora
terminal if later Git writes are blocked. They never initialize another repository,
reset existing commits, change dates, touch databases or push.

First approve a sequence and make the documentation corrections above. Review the
candidate files again if anything changed. Use your real configured author identity;
if Git requests one, set user.name/user.email locally yourself. Do not invent an
author or set GIT_AUTHOR_DATE/GIT_COMMITTER_DATE.

The following applies the **eight-commit** proposal only. It intentionally stops
if a commit already exists, the index is nonempty, the file set changed, or an
unapproved source file differs from the reviewed fingerprint. Approved corrections
to the three documentation files are allowed; review and rescan those edits first.

```bash
cd ~/codegrid/codex-projects/test-project
# ONLY AFTER EXPLICIT APPROVAL of the eight-commit plan and final security review:
python3 - <<'PYCODE'
import hashlib
import json
import os
import subprocess
from pathlib import Path

plan = json.loads(Path('docs/commit-plan.json').read_text())

def git(*args, check=True, input=None):
    return subprocess.run(['git', *args], input=input, capture_output=True,
                          check=check)

for key in ('GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
            'GIT_COMMON_DIR', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
            'GIT_AUTHOR_DATE', 'GIT_COMMITTER_DATE'):
    if os.environ.get(key):
        raise SystemExit(f'Review/unset {key} before using this plan.')
if Path(git('rev-parse', '--show-toplevel').stdout.decode().strip()).resolve() != Path.cwd().resolve():
    raise SystemExit('Wrong repository root; stop.')
if git('branch', '--show-current').stdout.decode().strip() != 'main':
    raise SystemExit('Expected main; stop.')
if git('rev-parse', '--verify', 'HEAD', check=False).returncode == 0:
    raise SystemExit('Commits now exist. Re-plan continuation; do not reset/amend.')
if git('ls-files', '--cached', '-z').stdout:
    raise SystemExit('Index is not empty. Preserve it and inspect before continuing.')
expected = {f for entry in plan['commits'] for f in entry['files']}
if sum(len(entry['files']) for entry in plan['commits']) != len(expected):
    raise SystemExit('Duplicate manifest paths; stop.')
actual = {p.decode() for p in git('ls-files', '--others', '--exclude-standard', '-z').stdout.split(b'\0') if p}
if actual != expected:
    raise SystemExit('Candidate file set changed. Review and update the plan first.')
allowed_edits = set(plan['planned_documentation_updates'])
for filename, digest in plan['original_file_sha256'].items():
    if filename not in allowed_edits and hashlib.sha256(Path(filename).read_bytes()).hexdigest() != digest:
        raise SystemExit(f'Reviewed source changed: {filename}')
for kind in ('GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT'):
    git('var', kind)  # Validate identity without printing it here.

for entry in plan['commits']:
    git('--literal-pathspecs', 'add', '--', *entry['files'])
    staged = {p.decode() for p in git('diff', '--cached', '--name-only', '-z').stdout.split(b'\0') if p}
    if staged != set(entry['files']):
        raise SystemExit('Unexpected staged paths; stop and inspect without resetting.')
    git('diff', '--cached', '--check')
    print(git('diff', '--cached', '--stat').stdout.decode(), end='')
    body = ('Present-day logical import of the existing M3.4 source. '
            'This does not reconstruct historical milestone snapshots or dates.')
    print(git('commit', '-m', entry['message'], '-m', body).stdout.decode(), end='')

print(git('log', '--oneline', '--decorate', '--all').stdout.decode(), end='')
remaining = git('status', '--porcelain').stdout
print('Working tree clean.' if not remaining else remaining.decode())
PYCODE
```

If any command fails (including Git filesystem permissions, signing/hooks or identity),
stop and retain the current index/commits. Do not use reset/amend/rebase to restart
this plan. Inspect what succeeded and approve a continuation from that actual state.
The staging/commit loop was not executed during preparation; only its syntax and
read-only preflight were validated. The three-commit fallback requires
its own approved sequence (explicit paths are in the JSON); do not run the
primary loop to implement that alternative.
