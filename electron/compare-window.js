'use strict';

// Native window lifetime owns the latest rendered snapshot; comparison policy stays in the session.
function createCompareWindow({ createWindow, document, preload, protectWindow, onClosed }) {
  let current = null;
  const live = owned => current === owned && !owned.window.isDestroyed();
  const send = owned => {
    if (live(owned) && owned.ready) owned.window.webContents.send('compare:update-data', owned.payload);
  };

  function open(payload) {
    if (current && live(current)) {
      current.payload = payload;
      if (current.window.isMinimized()) current.window.restore();
      current.window.show();
      current.window.focus();
      send(current);
      return;
    }
    const window = createWindow({
      width: 1200, height: 700, minWidth: 800, minHeight: 500,
      title: '字幕比對', autoHideMenuBar: true,
      webPreferences: { preload, nodeIntegration: false, contextIsolation: true },
    });
    const owned = { window, payload, ready: false };
    current = owned;
    window.setMenu(null);
    protectWindow(window, { document });
    window.webContents.once('did-finish-load', () => {
      if (!live(owned)) return;
      owned.ready = true;
      send(owned);
    });
    window.on('closed', () => {
      if (current !== owned) return;
      current = null;
      onClosed();
    });
    window.loadFile(document);
  }

  return Object.freeze({
    open,
    sync(payload) {
      if (!current || !live(current)) return false;
      current.payload = payload;
      send(current);
      return true;
    },
    isSender(sender) {
      return !!(current && live(current) && sender === current.window.webContents);
    },
  });
}

module.exports = { createCompareWindow };
