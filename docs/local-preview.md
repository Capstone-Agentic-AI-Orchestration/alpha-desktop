# Isolated local website previews

The native preview integration requires the companion frontend and engine changes. The engine exposes `localPreviewService`; the renderer uses the optional `alphaDesktop.localPreview` bridge.

Only the trusted Alpha main frame may attach, hide, reload, stop or open a registered preview using its engine-issued capability. The website runs in a sandboxed WebContentsView without Alpha's preload or Node access. Requests are confined to the owned preview origin; navigation, popups, downloads and device permissions cannot broaden its scope.

The native observer reports bounded browser warnings/errors, failed loads and failed/blocked resources to the engine. External resource failures remain visible as preview-isolation diagnostics rather than being mistaken for a successful page render.

The engine owns the disposable saved-commit copy, sanitized process environment, package preparation, supported dev-server adapter, listener ownership and shutdown. Closing the app or losing the supervising engine pipe stops the owned process tree. Merely opening the side panel starts no server.

Run `npm run prepare:build` with the matching `ALPHA_FE_DIR` and `ALPHA_BE_DIR` sources to stage the renderer/server and perform the Electron runtime check. Local native checks confirmed preview startup, read-only source/diagnostic matching, composer Enter/Send while the preview ran, and chat-controlled shutdown. These checks did not execute paid model reasoning or publish an installer.
