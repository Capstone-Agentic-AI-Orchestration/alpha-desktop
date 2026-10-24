# Alpha Desktop 2.0.63

- Security & Code Quality leads dependency audit evidence and independent verification. The Orchestrator selects specialists and decides the next milestone.
- Repository-scoped audit, file and check tools enforce each task's assigned role and access. Missing audit findings can be replanned with Security while preserving saved work.
- Project chats keep separate build context and private session memory, with controls to inspect or clear it.
- Plan documents and agent activity coexist in right-panel tabs. The node header responds to the project sidebar, and build/recovery controls remain available above the composer.
- Includes the architecture-diagram fixes already merged into the source repositories.

## Reviewed source

- Backend: `8b9ab189671dc6f6bdfea6d249d909860a4788f9` ([PR 144](https://github.com/Capstone-Agentic-AI-Orchestration/alpha-be-main/pull/144)).
- Frontend: `b72a45b2fefcf83078feb447797bad0bb09d3145` ([PR 125](https://github.com/Capstone-Agentic-AI-Orchestration/alpha-fe-main/pull/125)).

Local builds and typechecks passed, with 3,170 backend tests and 452 frontend tests passing. Functional CI verify passed in both source PRs. The scanner was also exercised under Electron 33 / Node 20 against an isolated vulnerable dependency fixture.

The frontend repository has existing development dependency alerts for source-map-js and postcss-selector-parser. Functional test success does not certify the external SonarCloud quality gate.

## Distribution

Install the Setup executable for automatic updates. Portable users download the new portable executable. Each colleague signs in to their own providers and grants access to their own project repositories; the release does not transfer local credentials or automatically restart saved builds.

## Packaged source checkpoints

- Backend main: `ccbc4adc0b914aee6d61a6e78f6e84605f10d907`.
- Frontend main: `43d12158619b7ca4ee6b51d34f76bd710817f6c5`.

Both merge commits have the same source trees as the tested PR heads. The release script enforces clean, pushed main inputs and verifies the runtime and assets before publishing.
