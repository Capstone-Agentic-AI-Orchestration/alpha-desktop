# Alpha 2.0.82 — Kanban builds and recovery

Developers can plan and control builds from project tasks and the right-side Alpha panel. PMs manage tasks and review delivery manually. The existing orchestration engine, specialist scopes and permissions continue to apply.

- Project navigation shares the title row; project details have a dedicated tab.
- Build requests are acknowledged and deduplicated, with explicit waiting and queue controls when a repository is busy.
- Plans can be revised before execution without cancelling the build.
- Recovery preserves saved changes, supports reviewed archive restoration and permits a bounded restart after the developer supplies a correction. Attempts and global budgets remain enforced.
- Task status, checklist evidence and progress reflect the parent orchestration. Stale connections disable controls until state is refreshed.
- Standalone internal Chat stays hidden; task conversations use the existing records and execution path.

## Validation status

Source PRs are merged. The release packages clean, pushed source main commits:

- Frontend: `8babdb776b5b7dc09bc65dcea9cb3a81401db004`.
- Backend: `cd8ef77cfada615f426062c39571ac3985fd182b`.

- Frontend: 676 tests across 79 suites passed; typecheck passed. Follow-up accessible-label checks passed.
- Backend: 3,609 tests passed in the full run; 16 old role-fixture failures were corrected, and all 37 tests in those two suites passed on rerun. The final focused reliability run passed 124 tests across 12 suites; build and typecheck passed.
- Desktop: 36 appearance checks and 4 local-access checks passed. Renderer/server staging passed, including live Supabase configuration verification and workflow provisioning settings.
- GitHub verification passed for both source PRs, covering frontend and backend tests, typecheck and build. The merged main trees match those verified source heads.
- GitHub verification must pass before publication. SonarCloud is deferred at the requester's direction: frontend quality-gate findings and the failed backend analysis remain unresolved and are not represented as passing.

Source PRs: [frontend #179](https://github.com/Capstone-Agentic-AI-Orchestration/alpha-fe-main/pull/179) and [backend #175](https://github.com/Capstone-Agentic-AI-Orchestration/alpha-be-main/pull/175).
