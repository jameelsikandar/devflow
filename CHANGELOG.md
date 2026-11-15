# Development milestones

This changelog describes the completed implementation through DevFlow 2.0 M3.4.
It is not a reconstruction of Git history or a claim about original commit dates.
The project had no initialized Git repository during its original development.
It was later initialized locally on `main`. No complete earlier application source
snapshots were recovered. The approved Git organization therefore uses eight
present-day logical import commits, as listed in COMMIT_PLAN.md, with actual commit
dates and the owner's existing Git identity. These commits group the current source
for review; they do not reconstruct past milestone source states. All seven genuine
migrations retain their original filenames/content and are imported together.

| Milestone  | Delivered implementation                                                                                                                        | Preserved evidence                                                |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Foundation | Sessions, workspace membership, projects, Kanban, task editing/comments, analytics, themes and presence                                         | Initial migration; ARCHITECTURE.md; docs/README_LEGACY.md         |
| M1         | Gantt/timeline, milestones, scheduling, dependencies, cycle prevention, planned critical path and version checks                                | Roadmap migration; roadmap services/UI/tests; UPGRADE_PLAN.md     |
| M2         | Provider-compatible AI project manager, eight authorized tools, persistent history, safe Markdown, explicit proposal approvals and Quick Drafts | Agent manager migration; AI_PROJECT_MANAGER.md; AI_CHAT_UX.md     |
| M3.1       | GitHub OAuth repository connections, repository checks, signed raw-body webhook ingestion and replay-safe receipts                              | Webhook foundation migration; GITHUB_INTEGRATION.md               |
| M3.2       | PostgreSQL-backed worker, leases/fencing/recovery, normalized observations, authorized task linking and read-only task GitHub activity          | Processing migration; worker and association tests                |
| M3.3       | Administrator-managed versioned workflow rules, audit history, priority/conflict checks and read-only previews                                  | Workflow definitions migration; rule services/UI/tests            |
| M3.4       | Confirmed future-event status automation, durable executions, atomic task/activity writes, retries and historical-event protection              | Workflow execution migration; automation tests; UPGRADE_REPORT.md |

Later M3.4 repairs replace unsafe Prisma transaction spies in integration tests
without weakening production transactions or changing task data. See the latest
sections of VERIFICATION.md for actual test results and environmental limitations.

Migrations preserve genuine schema evolution. Historical documents, migrations,
partial schema checkpoints and test artifacts do not constitute complete earlier
working application snapshots, and were not used to fabricate milestone commits.
M3.5 and subsequent milestones are outside this import.
