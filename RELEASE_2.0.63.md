# Alpha Desktop 2.0.63

- Security & Code Quality leads dependency audit evidence and independent verification. The Orchestrator selects specialists and decides the next milestone.
- Repository-scoped audit, file and check tools enforce each task's assigned role and access. Missing audit findings can be replanned with Security while preserving saved work.
- Project chats keep separate build context and private session memory, with controls to inspect or clear it.
- Plan documents and agent activity coexist in right-panel tabs. The node header responds to the project sidebar, and build/recovery controls remain available above the composer.
- Includes the architecture-diagram fixes already merged into the source repositories.

## Reviewed source

- Backend: `8b9ab189671dc6f6bdfea6d249d909860a4788f9` ([PR 144](https://github.com/Capstone-Agentic-AI-Orchestration/alpha-be-main/pull/144)).
- Frontend: `b72a45b2fefcf83078feb447797bad0bb09d3145` ([PR 125](https://github.com/Capstone-Agentic-AI-Orchestration/alpha-fe-main/pull/125)).

Publication requires successful local builds and full tests, clean pushed release inputs, packaged runtime checks, and verified installer/update assets. The release command records the exact packaged source commits.

The frontend repository has existing development dependency alerts for source-map-js and postcss-selector-parser. Functional test success does not certify the external SonarCloud quality gate.

## Distribution

Install the Setup executable for automatic updates. Portable users download the new portable executable. Each colleague signs in to their own providers and grants access to their own project repositories; the release does not transfer local credentials or automatically restart saved builds.