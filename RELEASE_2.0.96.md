# Alpha Desktop 2.0.96 — Chat summary and skill shortcuts

- The pinned project summary docks beside the conversation when Open Tabs is closed, and becomes a floating overlay when Open Tabs is open.
- Skills are available from the composer’s **+** menu and can be selected per message with the `/` skill shortcut. The existing `@` agent mention shortcut remains available.
- The chat composer and conversation layout are refined to keep the conversation aligned and usable with the summary and side panel.

## Release sources

- Frontend: `ee8be30fd93d85ff36eab7dbb1c75e2f282c0993` (`main`).
- Backend: `af36b07e6f16b85c3e7bd91dfb952eef7b575e88` (`main`).

The desktop release workflow builds the Windows installer and portable app from these pushed source branches and publishes updater metadata after verifying the uploaded assets.
