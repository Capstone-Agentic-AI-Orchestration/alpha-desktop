'use strict';

/** Native preview surface. Only the trusted Alpha main frame can control it by a service-issued capability. */
function createPreviewSurface({ electron, window, service }) {
  const { WebContentsView, session, shell } = electron;
  let active;
  const detach = () => {
    if (!active) return;
    if (!window.isDestroyed()) window.contentView.removeChildView(active.view);
    if (!active.view.webContents.isDestroyed()) active.view.webContents.close();
    active = undefined;
  };
  const resolve = (id, capability) => {
    const record = service.resolveSurface(id, capability);
    if (!record) throw new Error('Preview is stopped or its access lease expired. Refresh its status first.');
    return record;
  };
  const bounds = value => {
    const size = window.getContentBounds();
    if (!value || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(value[key]))) throw new Error('Invalid preview bounds.');
    const zoom = window.webContents.getZoomFactor();
    const x = Math.max(0, Math.round(value.x * zoom)), y = Math.max(0, Math.round(value.y * zoom));
    return { x, y, width: Math.max(0, Math.min(Math.round(value.width * zoom), size.width - x)), height: Math.max(0, Math.min(Math.round(value.height * zoom), size.height - y)) };
  };
  const handle = async (event, action, value = {}) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('Untrusted preview controller.');
    if (action === 'detach') { detach(); return; }
    if (action === 'stop') { if (active?.id === value.id) detach(); await service.stopSurface(value.id, value.capability); return; }
    const record = resolve(value.id, value.capability);
    if (action === 'external') { await shell.openExternal(record.origin); return; }
    if (action === 'reload') { if (active?.id === record.id) active.view.webContents.reload(); return; }
    if (action !== 'attach') throw new Error('Unsupported preview action.');
    if (active?.id !== record.id) {
      detach();
      const isolated = session.fromPartition('alpha-preview-' + record.id);
      isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      isolated.setPermissionCheckHandler(() => false);
      isolated.on('will-download', event => event.preventDefault());
      // Fail closed: no access to Alpha on any loopback alias, remote services, or unexpected API origins.
      const allowed = new URL(record.origin);
      const report = (kind, message) => service.recordSurfaceDiagnostic(record.id, value.capability, kind, message);
      // Queries/fragments can carry credentials and are unnecessary to identify a failed resource.
      const resource = raw => { try { const url = new URL(raw); return url.origin + url.pathname; } catch { return '(unknown resource)'; } };
      isolated.webRequest.onBeforeRequest((details, callback) => {
        let permit = false;
        try { const url = new URL(details.url); permit = ['http:', 'ws:'].includes(url.protocol) && url.hostname === allowed.hostname && url.port === allowed.port && !url.username && !url.password; } catch {}
        if (!permit) report('blocked', 'Preview isolation blocked resource: ' + resource(details.url));
        callback({ cancel: !permit });
      });
      isolated.webRequest.onErrorOccurred(details => report('request', `${details.error}: ${resource(details.url)}`));
      isolated.webRequest.onCompleted(details => { if (details.statusCode >= 400) report('request', `HTTP ${details.statusCode}: ${resource(details.url)}`); });
      const view = new WebContentsView({ webPreferences: { session: isolated, contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, navigateOnDragDrop: false, spellcheck: false } });
      view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      view.webContents.on('console-message', (_event, level, message, line, sourceId) => {
        if (level >= 2) report('console', `${level === 2 ? 'Warning' : 'Error'}: ${message} (${resource(sourceId)}:${line})`);
      });
      view.webContents.on('did-fail-load', (_event, code, description, url) => {
        if (code !== -3) report('load', `${description} (${code}): ${resource(url)}`);
      });
      const guard = (event, url) => { try { if (new URL(url).origin === allowed.origin) return; } catch {} event.preventDefault(); };
      view.webContents.on('will-navigate', guard);
      view.webContents.on('will-redirect', guard);
      window.contentView.addChildView(view);
      active = { id: record.id, capability: value.capability, view };
      view.setBounds(bounds(value.bounds));
      await view.webContents.loadURL(record.origin);
    } else active.view.setBounds(bounds(value.bounds));
    return { attached: true };
  };
  const lease = setInterval(() => { if (active && !service.resolveSurface(active.id, active.capability)) detach(); }, 2000);
  lease.unref();
  window.webContents.on('did-start-navigation', () => detach());
  window.on('closed', () => { clearInterval(lease); detach(); });
  let queue = Promise.resolve();
  return { handle: (...args) => (queue = queue.catch(() => {}).then(() => handle(...args))), detach };
}
module.exports = { createPreviewSurface };
