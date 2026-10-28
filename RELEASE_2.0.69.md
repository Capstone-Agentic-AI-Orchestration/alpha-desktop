# Alpha Desktop 2.0.69

This release adds the Project QA Studio, main-chat build approvals and agent-managed local previews, the Cosmo orchestrator sphere/galaxy UX, and preview settings / run-hydration fixes.

- Project managers can author UAT checklists and review rounds, and clients can execute test items, attach screenshot evidence, and submit structured feedback.
- Plan-start and publication approvals work directly from the main chat composer, and accepted frontend checkpoints can launch pinned local previews.
- The orchestrator bar rests as a sphere and unfurls into the Cosmo galaxy during specialist handoffs.
- Saved project preview settings load via `GET /projects/:projectId/client-preview`, and historical failed runs no longer replay startup error toasts when hydrating a workspace.
