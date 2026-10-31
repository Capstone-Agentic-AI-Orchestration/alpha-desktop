# Alpha Desktop 2.0.73

This release automatically enforces lowercase naming for newly created repositories so Vercel can host frontend projects without error, and includes the client portal contact names and workspace tabs.

**Lowercase repository names for Vercel hosting.** Vercel projects take the repository's name and Vercel strictly rejects uppercase letters. Newly created repositories are now automatically normalized to lowercase in both the desktop UI as you type and in the backend engine before anything is provisioned on GitHub. For paired projects, `<name>-fe` and `<name>-be` are both guaranteed lowercase. Invalid sequences like `---` are also rejected up front before GitHub is touched. Existing repositories are unaffected.

**Client portal contact names and workspace tabs.** The signed-in client portal now displays the verified contact name in the sidebar rather than an email address, and introduces the multi-tab client workspace layout with preserved draft states.

Validated source commits: backend `8c3c08e19c18bdc1a7b0ddc853444dc915efddc8`, frontend `b596757d08d5d41e1459766c3aa68ca3ea02abc5`.

All backend, frontend, and desktop checks passed in CI and local test suites.

Source pull requests:

- Backend: https://github.com/Capstone-Agentic-AI-Orchestration/alpha-be-main/pull/163 and https://github.com/Capstone-Agentic-AI-Orchestration/alpha-be-main/pull/164
- Frontend: https://github.com/Capstone-Agentic-AI-Orchestration/alpha-fe-main/pull/166 and https://github.com/Capstone-Agentic-AI-Orchestration/alpha-fe-main/pull/167

The Windows installer is unsigned. Publishing this update does not restart a running desktop build.

