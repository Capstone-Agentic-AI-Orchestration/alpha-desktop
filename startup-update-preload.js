'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const STATE_CHANNEL = 'alpha:startup-update:state';
const ACTION_CHANNEL = 'alpha:startup-update:action';

contextBridge.exposeInMainWorld('alphaStartupUpdate', {
  onStateChanged(listener) {
    if (typeof listener !== 'function') throw new TypeError('Update state listener must be a function.');
    const handler = (_event, state) => listener(state);
    ipcRenderer.on(STATE_CHANNEL, handler);
    return () => ipcRenderer.removeListener(STATE_CHANNEL, handler);
  },
  action(action) {
    if (!['retry', 'continue', 'quit'].includes(action)) {
      return Promise.reject(new TypeError('Invalid startup update action.'));
    }
    return ipcRenderer.invoke(ACTION_CHANNEL, action);
  }
});
