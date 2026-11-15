# Repository preparation and history audit

## Approved execution — 2026-11-15

The owner initialized this local repository on `main` and explicitly approved the
eight-commit plan in COMMIT_PLAN.md and docs/commit-plan.json. Before execution,
Git confirmed zero commits, an empty index, no remote, and exactly the 201 approved
candidate paths. All 199 original file fingerprints matched the reviewed source.
The only approved existing-file edits are the history wording in README.md,
CHANGELOG.md and this document; application source, migrations and databases remain
unchanged. The two plan artifacts record approval rather than a pending proposal.

Execution stages only each manifest's exact literal paths, reviews the actual
index for credentials/generated artifacts, and uses the existing Git identity and
current dates. It never resets, amends, rebases, backdates, configures a remote or
pushes. `git log` and `git status` are authoritative for progress and completion;
this document does not predict commit hashes or claim completion before Git records
exist. If a Git write is denied, stop with any successful earlier commits intact
and use the approved Fedora commands from the actual current state.

### Historical preparation attempt

Before local initialization, no repository was found in this project or its
parents. The sandbox then exposed an empty read-only .git placeholder and rejected
`git init --initial-branch=main .` at .git/hooks with Read-only file system. No
permissions were changed or metadata moved/replaced to bypass that restriction.
The owner subsequently initialized Git locally; the earlier initialization blocker
and no-repository observation describe that earlier attempt, not the current state.

## History recovery decision

Inspected project files, siblings, local dependency backup, milestone documentation,
seven migrations and relevant temporary artifacts. No full earlier application
source snapshot, patch series, Git bundle or app-source archive was recovered.

- `node_modules.backup-*` contains dependencies, not earlier app source/tests.
- Relevant temporary `.tgz` files contain esbuild/Zod packages, not DevFlow snapshots.
- `/tmp/devflow-before-m3.prisma`, `before-m32`, `before-m33` and `before-m34` are
  schema-only checkpoints. They cannot reconstruct coherent earlier application states.
- Other relevant temporary artifacts are verification logs, schema SQL/diffs,
  PostgreSQL clusters, browser traces/screenshots or dependency caches. They are
  not source history and may contain local/private state; they were not imported.
- `.next` and `.worker` are generated output, not recoverable milestone source trees.

The earlier recommendation was one baseline because no genuine prior application
states could be reconstructed. The owner instead approved a logical partition of
the same current source into eight commits. This preserves the same historical
honesty while improving reviewability: all commits use present dates and no source
is stripped or rewritten into imagined earlier releases. Migrations and milestone
documents retain the genuine development context. The dependency-complete grouping
and validation of each cumulative prefix are documented in COMMIT_PLAN.md.

## Prepared files and exclusions

- README.md now describes the implementation through M3.4, installation, environment,
  migration safety, worker startup, testing and remaining acceptance gates.
- The original README is preserved unchanged in docs/README_LEGACY.md; historical
  statements there are superseded by current technical guides. Existing guides
  were retained. Prettier ignores that preserved historical document.
- CHANGELOG.md records milestone history without inventing commits/dates.
- `.gitignore` excludes real environment files, dependency trees/backups, generated
  Next.js/types/worker output, reports/traces/browser sessions, logs, local caches,
  credentials/private keys, database files/dumps/clusters and archives/backups.
- SQL is excluded by default with explicit exceptions for migration.sql files and
  the three existing SQL test sources. All seven migrations remain candidates.
- `.env.example` remains included. Its old shared local database password is now
  an explicit replacement placeholder; Compose/environment setup is documented.
  The actual `.env` was not changed or printed.
- Compose now requires an explicit POSTGRES_PASSWORD instead of a committed
  fallback. Actual environment files and existing databases were not modified.
- `.gitattributes` specifies LF text normalization and binary asset handling.

The ignore policy was tested with synthetic paths, retaining ten source/example
paths and excluding 61 sensitive/generated/backup paths. Actual candidate scanning
also checked that no dependency/build/browser artifacts or real env files slipped
through, and that SQL sources remained present.

## Credential review

All proposed files selected by the ignore policy were scanned for GitHub/Groq/OpenAI
key signatures, AWS access keys, private-key blocks, JWTs, npm credentials, database
dump signatures and exact matches to private server environment values. Findings
were reported by path/category only; no secret values were printed. Credential-like
literals and database URLs were reviewed in their example/test-fixture context.

The initial scan flagged a commented test-database URL matching the active local
example; the environment template was changed to an explicit placeholder. Remaining
review items are provider placeholders or synthetic tests; no usable private token,
encryption key, private-key block or production credential was identified in the
final proposed file set. The old Compose password fallback was also removed: Compose now requires an
explicit POSTGRES_PASSWORD matching DATABASE_URL. Existing environments must set
that variable before running Compose; existing database credentials are not rotated
and the real .env remains unchanged.

No external gitleaks/trufflehog scanner is installed here. Pattern/exact-match review
is not a guarantee against every possible secret. The earlier scan was a **candidate-worktree scan** before staging. Approved
execution additionally reviews each actual staged file before its commit. Review
the index again if any file changes after that review. Real
environment files, traces and data dumps must remain ignored.

## Verification

Actual results for this preparation run:

| Check                                   | Result                                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------------------------ |
| Unit/DOM tests                          | 326 passed, 37 files                                                                       |
| Full/core TypeScript                    | Passed                                                                                     |
| ESLint                                  | Passed                                                                                     |
| Prisma validation and client generation | Passed                                                                                     |
| GitHub worker compilation               | Passed                                                                                     |
| Webpack production build                | Passed                                                                                     |
| New documentation/Compose formatting    | Passed                                                                                     |
| Isolated PostgreSQL integration         | 6 setup failures; all 82 tests skipped, 0 passed; cannot reach localhost:5433/devflow_test |
| Credential scan                         | 199 candidate files; no high-confidence private-value/key/dump findings after review       |
| Ignore policy                           | 10 allowed and 61 excluded synthetic paths checked successfully                            |
| Git initialization                      | Blocked by read-only .git; no commits or log created                                       |

Installed binaries were run directly (`node_modules/.bin/vitest run`, `eslint .`,
`tsc --noEmit`, `tsc --noEmit -p tsconfig.core.json`, `prisma validate`, `prisma
generate`, `tsc -p tsconfig.worker.json`, `next build --webpack`) rather than pnpm's
sandbox-restricted installation wrapper. The integration config validated the
isolated devflow_test URL and the run cleared AI_API_KEY. Integration tests did not
pass or execute their assertions. No application migration/reset/reseed, worker
startup, rule enablement, task update or live GitHub/Groq call occurred. Previous
technical verification records remain preserved.

The credential scan included seven private environment values/URL-password
components and reviewed credential-like test/example literals without printing
values. That earlier candidate-worktree review did not certify an index; actual staged
content is reviewed separately during approved execution. Do not infer a clean Git status or a successful
commit from the passing application checks.

## Approved logical import execution

Use the eight exact file groups and conventional messages in COMMIT_PLAN.md and
`docs/commit-plan.json`. The user explicitly approved that sequence. The documented
three-commit fallback is not the chosen sequence and must not be substituted.

The Fedora execution block in COMMIT_PLAN.md checks repository root, branch, empty
initial index, absence of existing commits, complete manifest coverage and source
fingerprints. It allows the three explicitly approved history-document corrections.
Use it only from the state its preflight accepts. If some commits already exist,
stop and prepare a continuation from the actual log; do not reset/amend/rebase to
restart the sequence. Before every commit, review staged paths and content for
secrets and generated artifacts. Use your own real Git identity; do not set author
or committer date overrides.

After successful completion, verify:

```bash
git log --oneline --decorate --all
git rev-list --count HEAD
git status --short --branch
git remote
```

Expected on full success: eight commits, `main`, no staged/unstaged/untracked source
changes, and no remote. This expectation is not a fabricated result: if staging or
committing is blocked, report the actual count/log and preserve the current index.
No database reset, migration, reseed, live worker, rule enablement or provider call
is necessary to organize Git history. Publishing requires separate authorization.
No license or historical author identity was invented.
