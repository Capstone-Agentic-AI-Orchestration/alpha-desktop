# Alpha Desktop 2.0.71

Published builds can now continue through development and UAT using a separate, persistent delivery pipeline. A project developer can start automatic delivery without PM/admin authorization at the UAT stage, inspect the commits and CI evidence, and pause or resume the flow.

The backend requires independent Security review and Validation, checks the actual source and merge commits, and stops when required checks are missing, fail, or are skipped. Repairs stay within the original approved paths. Delivery grants, actions and commit evidence survive desktop restarts; repeated action failures pause further attempts. Production promotion and client handoff remain separate controls.

UAT readiness requires CI and matching Render/Vercel deployment commits for every codebase plus HTTP smoke checks. HTTP checks do not replace browser acceptance. Repositories must have strict required checks configured; the E-Commerce repositories checked during development still need that setup before a live pilot.

This release also includes the latest merged ticket lifecycle authorization and client/PM workspace refinements from main.

Validated source commits: backend `fe003bc76d66ba8418eea840ac97809076f4bf97`, frontend `0d4c2936a99fd2708d19b123aa582ea60d998a58`.

Both source PRs passed GitHub's verify checks. Frontend validation passed 625 tests, and desktop appearance validation passed 32 tests. The backend cloud-approval fixture was aligned with the current authenticated lifecycle runtime; Windows cleanup retries preserve the production authorization check. SonarCloud remains non-green and is not represented as a passing release check. Dependency manifests are unchanged in the application source changes; existing dependency alerts remain separate.

Source pull requests:

- Backend: https://github.com/Capstone-Agentic-AI-Orchestration/alpha-be-main/pull/158
- Frontend: https://github.com/Capstone-Agentic-AI-Orchestration/alpha-fe-main/pull/150

The Windows installer is unsigned. Publishing this update does not restart a running desktop build or promote any project to UAT.
