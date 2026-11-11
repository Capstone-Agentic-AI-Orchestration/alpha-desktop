# Alpha Desktop 2.0.98 — Quieter chat and animated startup

- Project chat replies read as plain text, without icons, names or timestamps. Agents appear only in the activity row under your message, which shows when they are working in the background and when they finish.
- Alpha's handoff notes moved into View activity.
- The project summary floats over the conversation, so opening it no longer shifts the messages or the composer. The right-edge hover handle was removed; use the buttons at the top of the chat.
- Alpha shows its animated logo while it starts and connects. With reduced motion turned on, the logo stays still.

## Release sources

- Frontend: 6808b646a226297d28bfe462add497e293dae7b6 (main, [PR #200](https://github.com/Capstone-Agentic-AI-Orchestration/alpha-fe-main/pull/200) and [PR #201](https://github.com/Capstone-Agentic-AI-Orchestration/alpha-fe-main/pull/201)).
- Backend: af36b07e6f16b85c3e7bd91dfb952eef7b575e88 (main).

The Desktop Release workflow builds and verifies the Windows installer, the portable app and the updater metadata before publishing them.
