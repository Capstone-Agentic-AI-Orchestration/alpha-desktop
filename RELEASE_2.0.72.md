# Alpha Desktop 2.0.72

This release cuts the Supabase egress from agent runs and closes two security gaps in the desktop engine.

**Less cloud traffic from runs.** The desktop no longer broadcasts every raw log line of an agent run to Supabase. Live logs stay on the machine running the agent, where the app already receives them directly. The cloud channel now carries only stage changes and the final outcome. In a live test, one run went from 51 cloud broadcasts to 8. The per-step activity feed is off by default (`ALPHA_CLOUD_RUN_ACTIVITY=1` turns it back on), and the saved run keeps its full activity. The unused "Run details" panel is removed. A project manager watching from another machine sees stage progress and the result, not each log line.

**The local engine answers only this app's window.** Until now, any web page open on the same computer could connect to the engine's run stream, and a page using DNS rebinding could read its API. The app now creates a random token at each launch and gives it only to its own window. The engine refuses API calls and stream connections without that token, and refuses requests addressed to any hostname other than loopback.

**Your GitHub token no longer reaches project scripts.** The update check used to place the signed-in GitHub token in the app's environment, where a project's `npm ci` during verification could read it. The token now goes straight to the updater. Verification commands get the same GitHub isolation as agent shells, and engine secrets are removed from every process the app starts. A project that installs a private GitHub dependency during verification needs `ALPHA_ALLOW_AGENT_GIT_CREDENTIALS=1`, as agent runs already did.

It also includes the "Project Review" rename (formerly QA Studio) and the latest merged client and PM workspace changes from main.

Validated source commits: backend `520fdb5d01eaf2d66ad0c312397a38346f7fb19c`, frontend `730f67bd18d8bed66eb43f1d1097919d057bcefa`.

The backend and frontend PRs passed GitHub's verify checks. Locally, the backend passed 3,538 tests, the frontend 635 and the desktop shell 36. A packaged build passed 23 end-to-end checks beside an installed 2.0.71:

- Token-less, wrong-token, rebound-Host and foreign-origin requests were refused.
- The app window's own calls and stream worked.
- The update check read the private releases.
- A child process spawned like verification saw no GitHub or engine token.

Source pull requests:

- Backend: https://github.com/Capstone-Agentic-AI-Orchestration/alpha-be-main/pull/161 and https://github.com/Capstone-Agentic-AI-Orchestration/alpha-be-main/pull/162
- Frontend: https://github.com/Capstone-Agentic-AI-Orchestration/alpha-fe-main/pull/164, https://github.com/Capstone-Agentic-AI-Orchestration/alpha-fe-main/pull/151 and https://github.com/Capstone-Agentic-AI-Orchestration/alpha-fe-main/pull/165
- Desktop: https://github.com/Capstone-Agentic-AI-Orchestration/alpha-desktop/pull/92

Installs on 2.0.71 or earlier keep the old behaviour until they update. Anyone running the engine from source who calls its API from their own scripts must now send the same `ALPHA_LOCAL_TOKEN` they set, or leave it unset. The Windows installer is unsigned. Publishing this update does not restart a running desktop build.
