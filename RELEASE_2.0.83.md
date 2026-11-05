# Alpha 2.0.83 — Orchestrator answers Ask Alpha

The board's Ask Alpha panel is now answered by the workspace's Orchestrator Agent, from the build records of the tasks you select.

- The Orchestrator answers as itself, with its own instructions, model and reasoning setting, and Alpha's read-only project and GitHub tools. It no longer answers as a generic assistant.
- Each selected task's latest build is found by task, including builds started from the old project chat: status, why it stopped, planned steps with their agents, and open review findings. With no task selected, the ten most recently updated tasks are used.
- No silent runtime switch: if the Orchestrator's runtime is at its usage limit, Ask Alpha says so. Ask Alpha still never starts a build.
- Replies show who answered.
- Alpha's official agents can no longer be archived or deleted. Any archived earlier are restored, and the Agents page shows "Official agents stay active" in place of Archive.

## Validation status

Source PRs are merged. The release packages clean, pushed source main commits:

- Frontend: `778efadc26cc9b98623cf8275e779333f9829ccc`.
- Backend: `b308fcdce833e33e701c3a2438b516cf3da2404b`.

- Frontend: 677 tests across 79 files passed; typecheck passed.
- Backend: new Ask Alpha, task-scope and official-agent tests passed; full run 3,628 of 3,633 with 5 failures in two orchestration worktree suites caused by timeouts and Windows file locks under load, both passing on their own (7 of 7); typecheck passed.
- Live check against a copy of a desktop database: the Orchestrator Agent answered task status from the build records with no tool calls.
- GitHub verification passed for both source PRs. SonarCloud: the backend analysis did not complete and the frontend quality gate reports findings in existing code of the touched files; neither is represented as passing.

Source PRs: [frontend #180](https://github.com/Capstone-Agentic-AI-Orchestration/alpha-fe-main/pull/180) and [backend #176](https://github.com/Capstone-Agentic-AI-Orchestration/alpha-be-main/pull/176).
