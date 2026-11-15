# DevFlow implementation plan

## Architecture

Next.js App Router, strict TypeScript and Tailwind; shared accessible Radix/shadcn-style components. TanStack Query handles server state, dnd-kit board interactions, Recharts database analytics. PostgreSQL with Prisma models and migrations. Database-backed opaque sessions with scrypt password hashing, CSRF origin enforcement, workspace-scoped authorization, validation, and rate limits. SSE provides reconnectable collaboration by observing durable activity records. GitHub OAuth tokens encrypted at rest; AI provider credentials stay on server.

## Phases

1. Inspect environment, verify package compatibility, document risks.
2. Configure foundation, normalized schema, migration, seed, session authentication and visual system.
3. Implement workspace/project/task CRUD, comments/activity, sortable Kanban, analytics.
4. Add live collaboration, GitHub OAuth/setup, AI abstraction, command palette, settings.
5. Run lint, types, tests, database/API integration, Playwright and production build; document verified limits.

## Risks and environment

- Empty repository; Node 22.23.1 and pnpm 11.9 available.
- Docker executable available but socket access denied. PostgreSQL binaries available; use an isolated local cluster for verification if possible. Deliver Compose for normal operation.
- External OAuth/AI credentials unavailable: deliver configuration paths, never simulate AI output.
- User requests a local PostgreSQL/Next.js deliverable; no hosted deployment is required.
- Package/network availability and browser runtime will be verified before committing to tooling.

## Completion tracking

- [x] Environment inspection and architecture
- [x] Foundation source, database schema, session authentication, and design system
  - Auth.js/Better Auth adoption remains incomplete; current sessions use Node crypto and PostgreSQL.
- [x] Core application source: workspace/project/task CRUD, comments/history, board, analytics
- [x] Advanced feature source: reconnecting SSE, OAuth/setup, AI adapter, command palette
- [x] README, architecture, Compose, seed, unit/API/E2E/SQL suites
- [x] ESLint: no errors/warnings; core TypeScript: passing; Vitest: 20 passing tests; PostgreSQL standalone migration and constraint tests
- [ ] Full install, generated Prisma client, full strict type check and production build (blocked by unavailable packages/network)
- [ ] Prisma/API integration and browser/accessibility/responsive verification (blocked by dependencies and denied sockets)
- [ ] Live OAuth/AI provider verification (credentials unavailable)

## Final verification notes

The application has been implemented as source, but is not a verified production build. No hosted deployment was requested. Docker socket access was denied, and a normal PostgreSQL server could not bind a socket. Standalone PostgreSQL verified migration SQL and database constraints. Cached packages supported ESLint and 20 unit tests; full dependency resolution failed. Exact limitations and reproducible local commands are in README.md.
