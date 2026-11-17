# DevFlow typography and readability

Committed as 3855411 on style/global-typography-readability, based on b92712e. This is a
focused presentation change; M3.5 commits/history and operational acceptance gates
are retained. No backend, schema, authentication, task data or automation changed.
Fedora-host browser tests and normal-zoom visual inspection passed as reported
by the owner; detailed visual/accessibility checks remain open below.

## Audit and semantic scale

Tailwind v4 is imported from src/app/globals.css. That stylesheet owns the palette,
shared components and most responsive rules; seven feature stylesheets specialize
roadmap, assistant/chat and GitHub panels. The audit found 271 literal pixel font-size
declarations in globals.css, 201 below 12px (including breakpoint duplicates and
artwork). Increasing body size alone would not affect those explicit declarations.
Recharts also used explicit 10–11px axis text and a 12px tooltip in React.

Sizes below assume the browser's default 16px root. The root font size is not fixed;
rem sizes follow user preferences and browser zoom. The existing Inter/Geist/system
font-family stack is preserved; no font download, dependency or lockfile change.

| Semantic token            | Before (representative)                             | After                                     |
| ------------------------- | --------------------------------------------------- | ----------------------------------------- |
| --font-size-body          | Body 13px; chat 14px, mobile chat 13px              | 0.9375rem / 15px                          |
| --font-size-navigation    | Sidebar 11px, project links 10.5px                  | 0.875rem / 14px                           |
| --font-size-control       | Buttons 11–12px, filters often 9–10px               | 0.875rem / 14px                           |
| --font-size-input         | Dialogs 12px, some inputs 10–11px                   | Control size; 1rem / 16px at <=720px      |
| --font-size-task          | Cards/list titles 11px, dashboard focus titles 10px | 0.9375rem / 15px                          |
| --font-size-description   | Descriptions often 9–11px; GitHub panels 12px       | 0.8125rem / 13px                          |
| --font-size-metadata      | Dates, labels, IDs and status text often 8–11px     | 0.75rem / 12px                            |
| --font-size-code          | Code/diagnostics generally 11–12px                  | 0.8125rem / 13px; compact SHA labels 12px |
| --font-size-caption       | Chart axes 10–11px                                  | 0.75rem / 12px                            |
| --font-size-subheading    | Some headings 12–14px                               | 1rem / 16px                               |
| --font-size-section       | Some panel headings 13–14px                         | 1.125rem / 18px                           |
| --font-size-feature-title | Feature headings 21–26px                            | 1.5625rem / 25px                          |
| --font-size-page-title    | Main page headings 30px, mobile often 23–25px       | 1.875rem / 30px                           |

Individual larger metrics, Markdown headings and roadmap summary headings retain
appropriate rem-based sizes rather than being forced into a single heading role.
Shared line-height tokens use 1.6 body, 1.4 compact text, 1.3 headings and 1.75 reading
text. Buttons and labels retain their semantic hierarchy. Tailwind xs/sm/base/lg
sizes reference the shared scale; existing component declarations reference tokens
in their original rules rather than a new trailing override stylesheet.

Meaningful typography is not reduced at mobile breakpoints. The intentional mobile
input increase to 16px improves focus usability; buttons and navigation stay 14px.
Exceptions are decorative banner glyphs/brand marks, artwork captions and avatar
initials, whose proportions remain responsive and expressed in rem. Avatar initials
are accompanied by names/tooltips; artwork is not a task-information surface.

## Contrast and layout

- Muted text changes from #777981 to #a2a3ad in dark mode and #81808f to #656471
  in light mode. Light accent becomes #764bb2, green #246946 and red #a73535;
  warning colors are theme-aware. The lavender identity is retained.
- Semantic text, secondary, muted, accent, success, error and warning tokens meet
  **at least 4.5:1** mathematically against background, sidebar, surface, raised,
  hover and accent surfaces in both palettes. The minimum tested combination is
  approximately 4.72:1. Primary button normal/hover foreground pairs also pass.
- Status/priority text now uses theme tokens instead of dark-only pastel literals.
  Light primary-button hover has a darker background for its white label. Banner
  copy and code highlighting receive targeted contrast corrections. Today text no
  longer inherits a translucent roadmap overlay's opacity.
- Arbitrary Kanban label colors remain as a tint/colored edge; the label name uses
  the theme's primary text. Label values and task interactions are unchanged.
- Cards have appropriate padding and wrapping; focus-task names can wrap. Project
  descriptions retain two-line presentation using content-relative height instead
  of a fixed 31/40px crop. Footers, chart legends and mobile page actions wrap.
- Task-table columns give status/date text more space; horizontal scrolling remains
  within the existing table container. Kanban columns are at least 250px, with
  scrolling confined to the existing board. No page-level overflow hiding is added.
- Roadmap geometry remains **54px rows / 260px labels**, unchanged bar positions,
  date scale and connector coordinates. Compact label leading fits its two lines;
  scheduling, dependency and drag logic are untouched.
- The assistant retains its existing workspace/history/message/composer hierarchy,
  scroll regions and approval behavior. Tables/code keep their local scroll areas.
  Composer inputs use unitless leading with the existing max-height/growth behavior.
- Recharts uses shared caption/description sizes; less-negative left margins make
  room for larger axis labels. Metric calculations and chart data are unchanged.

Palette calculations are not a claim of full WCAG conformance. Actual rendered
contrast on gradients, focus treatment, zoom, user content and layout must still be
inspected in detail. The owner reports positive normal-zoom visual inspection;
no screenshots were supplied and complete visual/accessibility acceptance is not claimed.

## Verification and local browser acceptance

### Codex sandbox implementation evidence

These are the earlier implementation checks, not reruns by this documentation update:

- Full unit/HTTP/DOM suite: **485 passed in 50 files**, including nine new typography,
  palette and real Kanban-rendering regressions.
- Full/core TypeScript, ESLint, repository formatting and diff checks: passed.
- Credential-free webpack production build in a separate /tmp source copy: passed.
  Existing application .next/dev output was not used or overwritten.
- Focused Playwright invocation for github-health.spec.ts and workspace.spec.ts
  exited before tests because the test web server could not start. A separate
  127.0.0.1:3100 bind probe returned EPERM. **Zero browser tests passed/executed**.
- Connected browser inventory failed: browser access host unavailable. No native
  browser zoom, desktop/mobile visual inspection or screenshots were performed.
- PostgreSQL integration was not rerun: no backend/schema change. Prior owner SQL
  evidence remains 124/124 on devflow_test, not a new result of this UI branch.

### Subsequent Fedora-host verification — owner-reported

For the committed typography implementation **3855411**, the owner independently
reports **12/12 Playwright browser tests passed in 3.1 minutes**, covering desktop
Chromium and mobile Chromium. Manual visual inspection was completed at normal
browser zoom; the owner found the overall application typography substantially
more readable. This successful host execution resolves the earlier environment
blocker for that run; it does not turn the sandbox EPERM attempt into a pass.

No exact invocation, per-test report, screenshot set or width/theme/keyboard/zoom
matrix was supplied. Do not infer that every responsive width, both themes, each
keyboard interaction, every added assertion or non-default browser zoom level was
individually verified from the aggregate 12/12 result or positive visual feedback.
Detailed responsive/accessibility/zoom checks below remain unconfirmed.

PostgreSQL integration was **not rerun** for this typography-only change; the prior
124/124 devflow_test result is separate historical M3.5 evidence.

### GitHub-hosted CI scope

The owner identifies a previously successful **M3.5 hosted CI run at b92712e**.
That is evidence for the earlier base commit, not for typography commit 3855411.
**Hosted CI has not run for 3855411** or this documentation follow-up. No run URL
or additional hosted test totals are asserted here. No push or merge is authorized
or performed by this update.

### Detailed acceptance still to record

The new typography tests parse actual styles and independently calculate palette
contrast. They protect semantic roles, scaling units and roadmap geometry; they are
not layout-engine tests. The existing browser journeys now check computed sizes,
roadmap row geometry, both themes at 1440/1024/768/390px, and keyboard focus with
200% root text resizing. **Root text resizing is distinct from native browser zoom.**
The reported 12/12 run does not identify individual assertions or their matrix
results. Retain per-case evidence before closing each detailed acceptance check.

For future reproduction and outstanding detailed checks, use the Fedora terminal
from this branch with the isolated database already migrated:

```bash
node --import tsx <<'NODE'
require('dotenv/config');
const { requireTestDatabase } = require('./tests/database-config.ts');
const target = requireTestDatabase(process.env.DATABASE_URL, process.env.TEST_DATABASE_URL);
if (target.pathname !== '/devflow_test' ||
    !['localhost', '127.0.0.1'].includes(target.hostname) || target.port !== '5433')
  throw Error('Expected reviewed localhost:5433/devflow_test');
console.log('Verified isolated test target', target.hostname, target.port, target.pathname);
NODE
# Continue only after guard succeeds. No reset/seed/migration needed for this change.
AI_API_KEY= GITHUB_CLIENT_ID= GITHUB_CLIENT_SECRET= pnpm exec vitest run --pool=forks
pnpm typecheck
pnpm typecheck:core
pnpm lint
pnpm format:check
# Keep test port 3100 free; isolate .next from the running dev server.
AI_API_KEY= GITHUB_CLIENT_ID= GITHUB_CLIENT_SECRET= pnpm test:e2e --reporter=list,html
```

Review rendered Dashboard, Tasks, Projects, Board/task dialog, Roadmap, GitHub,
AI chat/Quick Drafts/proposals, Analytics and Settings at **100% browser zoom** in
both themes and all four requested widths. Use disposable devflow_test fixtures;
never edit DEV-002 or enable live rules for visual checks. Inspect long titles,
dates, role/status labels, tables, inputs, errors and narrow dialogs. Confirm no
page-level horizontal overflow and expected local board/timeline/table scrolling.
Verify focus indicators, keyboard navigation/drag scheduling and accessible composer.

Repeat representative views at native 125%, 150% and 200% browser zoom, checking
reflow and reachable controls. Native zoom is an owner/browser action, not a CSS
zoom substitute. Store screenshots/reports under ignored test-results/, never
commit authenticated screenshots or tokens. Record actual failures rather than
marking browser/visual acceptance complete from unit, discovery or build results.

The implementation commit is 3855411 (style: improve global typography and
readability). This documentation-only follow-up is prepared separately as
docs: record typography browser verification. It does not amend the implementation
commit. The owner reviews and commits locally; no push, merge or history rewrite.
