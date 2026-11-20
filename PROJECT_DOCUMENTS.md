# M4.1 — project document management

M4.1 implements document metadata and permissions. It does not implement a text
editor, collaborative body storage, Yjs, WebSockets, comments or version history.
`version` is an optimistic metadata concurrency counter, not a revision archive.

## Use

After the additive migration is approved and applied, open **Documents** in the
existing workspace navigation. Choose a project, then **New document**. Enter a
title and optional summary. Select a document card to view details, rename/update
the summary, manage access or confirm archival. **Show → Archived documents**
retains access to archived records; there is no deletion or restore operation in
M4.1. Archived projects/documents are read-only.

Documents are private by default. Other project members do not see them unless
explicitly granted access; workspace owners/admins retain management access.

| Actor                                            | Read | Rename/update summary | Grant/revoke and archive |
| ------------------------------------------------ | ---- | --------------------- | ------------------------ |
| Current workspace owner/admin                    | Yes  | Yes, when active      | Yes, when active         |
| Document owner with current workspace membership | Yes  | Yes, when active      | Yes, when active         |
| Explicit editor with current membership          | Yes  | Yes, when active      | No                       |
| Explicit reader with current membership          | Yes  | No                    | No                       |
| Ungranted member or foreign workspace user       | No   | No                    | No                       |

Ownership is assigned from the authenticated session and cannot be supplied or
transferred by these APIs. Only title/summary metadata is editable. API reads are
private/no-store; inaccessible document IDs return 404. Readers receive no access
list. Only user IDs/names needed by authorized views are selected, not credentials.

## Schema and integrity

Migration: `prisma/migrations/202611200001_project_documents/migration.sql`.
Adds `DocumentAccess`, `ProjectDocument`, `DocumentGrant`, indexes and foreign keys.
It does not alter existing task, GitHub or automation records.

- Document/project workspace identities are constrained by a composite foreign key.
- Grants reference both the scoped document and an existing workspace membership.
  Removing membership cascades grants and server checks deny subsequent requests.
- Metadata versions, timestamps and authenticated updater IDs are persisted.
- Writes lock the active project first, then share-lock membership rows and check
  authorization/version inside the transaction. Grant changes and metadata updates
  commit together; stale edits return 409 instead of overwriting newer metadata.
- Short repeatable-read list/detail transactions use a consistent authorization
  snapshot. They do not retroactively erase information already read before access
  revocation. Ownership remains recorded if membership ends; administrators can
  still manage the document. The owner user foreign key restricts user deletion.
- Lists return 25 records per page, accessible total and `hasMore`; offset is bounded
  at 10,000. A document supports at most 100 explicit grants, so its access list is
  complete. Large-scale search/cursor pagination and ownership transfer are deferred.

## API

All paths below require an authenticated session and `?workspaceId=...`.
Mutations require the existing same-origin request checks and JSON bodies.

| Method | Path                                                    | Body/query                                                   |
| ------ | ------------------------------------------------------- | ------------------------------------------------------------ |
| GET    | `/api/projects/:projectId/documents`                    | `offset=0`, `archived=false` or `true`                       |
| POST   | `/api/projects/:projectId/documents`                    | `{ "title": "Guide", "summary": "Optional summary" }`        |
| GET    | `/api/projects/:projectId/documents/:id`                | None                                                         |
| PATCH  | `/api/projects/:projectId/documents/:id`                | `{ "title": "Renamed", "summary": "Summary", "version": 0 }` |
| POST   | `/api/projects/:projectId/documents/:id/archive`        | `{ "version": 0 }`                                           |
| PUT    | `/api/projects/:projectId/documents/:id/grants/:userId` | `{ "version": 0, "access": "READER" }` or `EDITOR`           |
| DELETE | `/api/projects/:projectId/documents/:id/grants/:userId` | `{ "version": 0 }`                                           |

Titles are trimmed and limited to 1–160 characters; summaries to 2,000. Versions
are nonnegative integers. Unknown fields, including a supplied owner or body, are
rejected. No document DELETE endpoint exists. Mutations have the existing database
rate limiter. Create has no idempotency receipt; the UI blocks duplicate pending
submission, but a manually repeated POST can create a second document.

## Verification and authorization boundary

Executed for this implementation:

- 37 new unit/HTTP/DOM tests: 23 service/policy, six route, eight interface tests.
- Full unit/HTTP/DOM suite: **522/522 across 53 files** using a temporary Vitest
  config with `envDir: false`, synthetic environment and mocked database/providers.
- Full/core/worker TypeScript, ESLint, changed-file Prettier, schema validation,
  Prisma formatting and client generation passed.
- Webpack production build passed in `/tmp/devflow-m4-build-9z6kgoyp` using a source
  snapshot, installed dependencies and an unreachable synthetic database URL.
  The running application's `.next` output was not used as the build directory.
- SQL integration: **not executed**. Eleven cases are prepared in
  `tests/documents.integration.test.ts`, with an additional exact `devflow_test`
  guard before database connection/fixtures/cleanup.
- Browser/visual acceptance: **not executed**. DOM tests do not establish rendered
  responsive behavior, browser focus handling or real database persistence.

No existing database was inspected, migrated, reset or seeded. No retained M3.5
rehearsal resource/evidence was accessed or changed. No live GitHub or AI call ran.
The application Documents APIs require the new migration before runtime acceptance;
an old database will return the existing error state rather than have new tables.

### Fedora-local database verification — requires separate approval first

Approve migration and fixture/test writes to **devflow_test only** before running:

```bash
: "${TEST_DATABASE_URL:?Export the isolated test URL without printing it}"
node -e 'const u=new URL(process.env.TEST_DATABASE_URL); if (!["postgres:","postgresql:"].includes(u.protocol) || decodeURIComponent(u.pathname)!=="/devflow_test") throw Error("Expected devflow_test; refusing migration")'
DATABASE_URL="$TEST_DATABASE_URL" node_modules/.bin/prisma migrate deploy
pnpm db:generate
AI_API_KEY= pnpm test:integration
pnpm typecheck
pnpm typecheck:core
pnpm lint
pnpm test
pnpm build:webpack
```

The integration configuration additionally requires a separate application
`DATABASE_URL` for its database-separation guard. Do not print either URL. Export
`TEST_DATABASE_URL` from approved local configuration; no new credentials are
provided here. Applying this migration to the development database requires its
own approval. Playwright must use the guarded test database, with no conflicting
server, after database verification is authorized. Do not infer API/E2E success
from type checks or test discovery.
