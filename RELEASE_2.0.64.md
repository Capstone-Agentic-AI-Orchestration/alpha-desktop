# Alpha Desktop 2.0.64

Live Agent Actions now shows the orchestrator, specialists, and expandable task branches as an interactive 3D hierarchy.

- Floating names and status dots keep the graph readable. Activity cards open on selection.
- The side inspector shows recorded commands, output, verification exit codes, file changes, and task history.
- Animated paths connect the spheres and avoid floating labels. Layout changes move nodes and paths together.
- The graph uses a static purple dotted background without node orbit rings.
- Includes responsive mobile inspection, keyboard navigation, reduced motion, and an SVG fallback.

## Source checkpoints

- Frontend: `feat/live-agent-hierarchy` at `9816ff475d19e665500d3fa6a82f40bfbe148fd0`, including the current published frontend main changes.
- Backend: `main` at `ccbc4adc0b914aee6d61a6e78f6e84605f10d907`, retaining the backend shipped with 2.0.63.
- Desktop: based on `origin/main` at `c93c0b2928579b6b865da09ee936abe2b0e2389c`.

## Validation

- All 459 frontend regression tests passed after integrating current main.
- Fourteen browser checks passed with fixture activity, covering the hierarchy, command updates, task isolation, mobile sheet, keyboard tabs, WebGL fallback, and reduced motion.
- The release command builds both source repositories, verifies the public cloud configuration, checks the daemon on Electron's Node runtime, and verifies installer, portable, blockmap, and updater assets before publication.

Command history displays the activity recorded by the runner; missing command output or exit codes are not inferred.
