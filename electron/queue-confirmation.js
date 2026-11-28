'use strict';
const path = require('node:path');
const { BrowserWindow } = require('electron');

const activeParents = new WeakSet();

// Runs in an isolated world of the main-owned local document. No preload or IPC
// grants the workspace or queue renderer a way to answer this question.
function prepareDocument({ title, message, detail, accept, cancel }) {
  const { document } = globalThis;
  for (const [id, value] of Object.entries({ title, message, detail, accept, cancel })) {
    document.getElementById(id).textContent = value;
  }
  globalThis.pointerChoice = new Promise(resolve => {
    document.addEventListener('click', event => {
      if (!event.isTrusted || event.detail < 1 || event.button !== 0 || !event.pointerType) return;
      if (event.target.id === 'accept') resolve(true);
      if (event.target.id === 'cancel') resolve(false);
    });
  });
}

function requestQueueConfirmation(parent, question, signal) {
  if (!parent || parent.isDestroyed() || signal?.aborted || activeParents.has(parent)) return Promise.resolve(false);
  activeParents.add(parent);
  return new Promise(resolve => {
    let child, settled = false, ready = false;
    function finish(approved) {
      if (settled) return;
      settled = true;
      parent.removeListener('closed', cancel);
      signal?.removeEventListener('abort', cancel);
      activeParents.delete(parent);
      if (child && !child.isDestroyed()) child.destroy();
      resolve(approved);
    }
    function cancel() { finish(false); }
    async function show() {
      child = new BrowserWindow({
        parent, modal:true, show:false, title:question.title, width:520, height:310,
        minWidth:360, minHeight:240, minimizable:false, maximizable:false, fullscreenable:false,
        backgroundColor:'#161a22', autoHideMenuBar:true,
        webPreferences:{sandbox:true, contextIsolation:true, nodeIntegration:false, devTools:false},
      });
      child.setMenu(null);
      const contents = child.webContents;
      child.once('closed', cancel);
      child.once('unresponsive', cancel);
      contents.once('render-process-gone', cancel);
      parent.once('closed', cancel);
      signal?.addEventListener('abort', cancel, {once:true});
      contents.setWindowOpenHandler(() => ({action:'deny'}));
      contents.on('will-navigate', event => { event.preventDefault(); cancel(); });
      contents.on('before-input-event', (event, input) => {
        if (['Tab','Enter',' ','Escape'].includes(input.key)) event.preventDefault();
        if (input.type === 'keyDown' && input.key === 'Escape') cancel();
        if (ready && input.type === 'keyDown' && input.key === 'Enter' && !input.isAutoRepeat &&
            !input.isComposing && !(input.alt || input.control || input.shift || input.meta) && child.isVisible() && child.isFocused()) {
          finish(true);
        }
      });
      await child.loadFile(path.join(__dirname, 'queue-confirmation.html'));
      if (settled) return;
      const run = code => contents.executeJavaScriptInIsolatedWorld(1001, [{code}]);
      await run('(' + prepareDocument.toString() + ')(' + JSON.stringify(question) + ')');
      if (settled) return;
      const answer = run('globalThis.pointerChoice');
      ready = true;
      child.show();
      const approved = await answer;
      if (!settled) finish(approved === true && child.isVisible() && child.isFocused() && !parent.isDestroyed());
    }
    show().catch(error => {
      if (!settled) console.error('[Queue] 無法顯示確認視窗：', error);
      cancel();
    });
  });
}

module.exports = { requestQueueConfirmation };
