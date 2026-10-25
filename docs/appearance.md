# Desktop appearance contract

The frontend owns the theme catalog, CSS and selection UI. The desktop owns the
validated catalog used for native chrome, the remembered selection and IPC.
There are no new dependencies.

The manifest format is unchanged:

```json
{
  "schemaVersion": 1,
  "defaultId": "alpha-violet",
  "themes": {
    "alpha-violet": {
      "id": "alpha-violet",
      "mode": "dark",
      "canvas": "#09090B",
      "shell": "#0D0D11",
      "symbol": "#A1A1AA"
    }
  }
}
```

IDs use lowercase ASCII letters/digits separated by single hyphens, start with a
letter and contain at most 64 characters. Prototype-related names are rejected.
Each key must match its entry's `id`. Mode is `light` or `dark`. Colors are opaque
six-digit RGB hex (`#RRGGBB`, case insensitive); shorthand, alpha, CSS functions,
paths and extra fields are rejected. The default must be the included
`alpha-violet` theme. Colors above are illustrative; only the selected frontend's
manifest supplies runtime colors.

`scripts/prepare.mjs` uses the exact `ALPHA_FE_DIR` selection (or its existing
`alpha-fe-main` default). Before building, it invalidates the previous staging
receipt and removes `dist/theme-manifest.json` so an old output cannot satisfy
the check. Frontend `scripts/build-themes.mjs` generates
`public/theme-manifest.json`; the frontend build must copy it
byte-for-byte into `dist/theme-manifest.json`. Prepare validates both, stages the
renderer, and checks the staged copy against that same source again. Only after
all prepare steps succeed does it write `build/appearance-build.json`, a versioned
SHA-256 receipt covering all packaged renderer paths and bytes, excluding source
maps as electron-builder does. No source path is stored in the receipt.

Startup reads only `build/renderer/theme-manifest.json` relative to the desktop
entrypoint. Missing/invalid manifests and missing/stale receipts fail startup
with an error dialog before the engine or window starts. This detects mixed or
modified output; it is a build consistency check, not an authenticity signature.
A complete older coherent renderer/receipt pair is still a valid older build.
`appearance.cjs` and both staged files are included by the packaging allowlist.

The profile preference is Electron `app.getPath('userData')/appearance.json`:

```json
{ "version": 1, "themeId": "alpha-violet" }
```

Missing, corrupt, unknown-version or removed-theme preferences default to the
manifest default. Writes use a unique temporary file in the same directory,
flush/close it, then rename it over the destination. Write failures reject the
request without changing current colors or emitting a change event. Invalid
preferences are repaired by the next successful selection. No renderer supplies
the preference path or any native color.

Before constructing a BrowserWindow, main resolves the selection once and uses
it for both `backgroundColor` (canvas) and `--alpha-theme=<id>`. On Windows the
hidden title bar overlay uses shell/symbol with the existing 40px height. Other
platforms keep their existing title bar behavior. Only explicitly registered
Alpha windows receive native updates and theme broadcasts; preview
WebContentsViews are never registered.

The preload bridge retains all existing capabilities and adds:

```ts
appearanceThemeId?: string;
setAppearanceTheme(id: string): Promise<{ themeId: string }>;
onAppearanceThemeChanged(listener: (id: string) => void): () => void;
```

Main accepts `alpha:set-appearance-theme` only from a registered, living Alpha
window's main frame while its URL names the exact staged renderer entrypoint
(query/hash routes are allowed). The sole payload is a catalog ID. Successful
changes atomically save, update registered windows, then broadcast
`alpha:appearance-theme-changed` with only the ID. Preload hides the Electron
event object, and its returned function removes only that subscription.

Before exposing the bridge on every load, preload synchronously requests
`alpha:appearance-theme-bootstrap`. Main uses the same sender checks as the
setter and immediately returns only the current cached ID, with no disk I/O,
window changes or asynchronous work. Invalid senders receive `null`. Consequently
`appearanceThemeId` reflects main's latest selection before renderer scripts run,
including on reload, even though Electron reuses the original startup argument.
The argument remains a fallback if bootstrap is unavailable. Main still sends a
supplemental `did-finish-load` notification; correctness before rendering does
not depend on that later event.

The frontend should apply a known `appearanceThemeId` before its initial render,
subscribe to changes, and use the resolved setter result as the accepted ID.
For compatibility with previous installed bridges,
the frontend must feature-detect both methods and the initial property, retain
its browser/local preference fallback when absent, validate received IDs against
its own catalog and handle setter rejection. Shared frontend types and behavior
are maintained by the frontend owner.

Run `npm run test:appearance` for isolated Node tests of manifest/output checks,
preference recovery, atomic write failures, sender boundaries, multiple windows,
preload subscription cleanup and actual main-script wiring with Electron mocked.
These tests do not launch, restart or modify the running app. A real frontend
build and visual Electron validation are separate integration checks.
