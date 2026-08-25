/* ============================================================================
   文本匹配 TXT 匯入 —— Electron / CDP 真機驗收
   ============================================================================
   先執行 npm run build，再執行：
     node scripts/acceptance/verify-transcript-txt-import.js

   使用獨立 user-data-dir 啟動開發 Electron，不碰使用者安裝版與正式設定。
   ============================================================================ */
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const ROOT = path.resolve(__dirname, '..', '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function getJSON(url) {
  return new Promise((resolve, reject) => {
    http.get(url, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (error) { reject(error); }
      });
    }).on('error', reject);
  });
}

async function waitFor(read, label, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(50);
  }
  throw new Error(`等待逾時：${label}${lastError ? `；${lastError.message}` : ''}`);
}

class CdpClient {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.nextId = 0;
    this.pending = new Map();
  }

  async connect() {
    this.ws = new WebSocket(this.url, { perMessageDeflate: false });
    await new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
    this.ws.on('message', raw => {
      const message = JSON.parse(raw);
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result);
    });
  }

  send(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const response = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    });
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    }
    return response.result.value;
  }

  close() {
    this.ws?.close();
  }
}

async function dispatchClick(client, rect, button = 'left') {
  const x = rect.left + Math.min(20, rect.width / 2);
  const y = rect.top + Math.min(10, rect.height / 2);
  await client.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x, y, button, clickCount: 1
  });
  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x, y, button, clickCount: 1
  });
}

function verifiedCleanup(profileDir) {
  const tempRoot = fs.realpathSync(os.tmpdir());
  const resolved = fs.realpathSync(profileDir);
  if (path.dirname(resolved) !== tempRoot || !path.basename(resolved).startsWith('subtool-txt-cdp-')) {
    throw new Error(`拒絕清除未驗證的路徑：${resolved}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

(async () => {
  if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) {
    throw new Error('找不到 dist/index.html，請先執行 npm run build');
  }
  const profileDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-txt-cdp-'));
  const transcriptPath = path.join(profileDir, 'many-lines.txt');
  const sourceLines = Array.from({ length: 5000 }, (_, index) => `Line ${index + 1}.`);
  fs.writeFileSync(
    transcriptPath,
    `  ${sourceLines[0]}  \r\n\r\n${sourceLines.slice(1).join('\r\n')}\r\n`,
    'utf8'
  );

  const port = await reservePort();
  const errors = [];
  const child = spawn(ELECTRON, [
    '.',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-sandbox',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows'
  ], {
    cwd: ROOT,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe']
  });
  child.stderr.on('data', chunk => errors.push(chunk.toString()));

  let client;
  try {
    const target = await waitFor(async () => {
      const targets = await getJSON(`http://127.0.0.1:${port}/json/list`);
      return targets.find(item => item.type === 'page' && item.title === 'SUB TOOL');
    }, 'SUB Tool 主視窗啟動', 15000);
    client = new CdpClient(target.webSocketDebuggerUrl);
    await client.connect();
    await client.send('Runtime.enable');
    await client.send('DOM.enable');
    await client.send('Page.bringToFront');

    await client.evaluate(`(() => {
      window.SUB.State.clips = [{
        id: 'txt-import-cdp-source', name: 'txt-import-cdp-source.wav', type: 'video',
        offset: 0, in: 0, out: 60, dur: 60, duration: 60, vtrack: 0,
        audioSourceId: 'txt-import-cdp-audio', audioSrc: 'txt-import-cdp-audio', primary: true
      }];
      window.SUB.State.duration = 60;
      window.SUB.State.viewStart = 0;
      window.SUB.State.pxPerSec = 10;
      window.SUB.drawTimeline();
      return true;
    })()`);
    const audioRect = await waitFor(
      () => client.evaluate(`(() => {
        const element = document.querySelector('.audio-clip-block');
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
      })()`),
      '音訊素材區塊'
    );
    await dispatchClick(client, audioRect, 'right');

    const menuRect = await waitFor(
      () => client.evaluate(`(() => {
        const element = [...document.querySelectorAll('#ctxmenu .ci')]
          .find(item => item.textContent.includes('語音辨識／文本匹配'));
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
      })()`),
      '語音辨識／文本匹配右鍵選單'
    );
    await dispatchClick(client, menuRect);

    await waitFor(
      () => client.evaluate("Boolean(document.getElementById('asrImportTranscriptButton'))"),
      '文本匹配視窗'
    );
    await delay(100);
    await client.evaluate(`(() => {
      const mode = document.getElementById('asrTaskMode');
      mode.value = 'align';
      mode.dispatchEvent(new Event('change', { bubbles: true }));
      const input = document.getElementById('asrTranscriptFileInput');
      window.__txtImportNativeClick = input.click.bind(input);
      window.__txtImportClickCount = 0;
      input.click = () => { window.__txtImportClickCount += 1; };
      return true;
    })()`);

    const buttonRect = await client.evaluate(`(() => {
      const element = document.getElementById('asrImportTranscriptButton');
      const rect = element.getBoundingClientRect();
      return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    })()`);
    await dispatchClick(client, buttonRect);
    const clickCount = await client.evaluate('window.__txtImportClickCount');
    if (clickCount !== 1) throw new Error('真實滑鼠點擊沒有命中匯入 TXT 按鈕');

    const documentNode = await client.send('DOM.getDocument', { depth: 1 });
    const inputNode = await client.send('DOM.querySelector', {
      nodeId: documentNode.root.nodeId,
      selector: '#asrTranscriptFileInput'
    });
    await client.send('DOM.setFileInputFiles', {
      nodeId: inputNode.nodeId,
      files: [transcriptPath]
    });

    const imported = await waitFor(
      () => client.evaluate(`(() => {
        const transcript = document.getElementById('asrTranscript');
        const summary = document.getElementById('asrTranscriptFileSummary');
        if (!transcript.value.includes('Line 5000.') || !summary.textContent.includes('5000 行')) return null;
        const button = document.getElementById('asrImportTranscriptButton');
        const row = document.getElementById('asrTranscriptRow');
        return {
          mode: document.getElementById('asrTaskMode').value,
          rowDisplay: getComputedStyle(row).display,
          buttonText: button.textContent.trim(),
          buttonVisible: button.getBoundingClientRect().width > 0 && button.getBoundingClientRect().height > 0,
          fileName: document.getElementById('asrTranscriptFileInput').files[0].name,
          importedLineCount: transcript.value.split('\\n').filter(line => line.trim()).length,
          firstLine: transcript.value.split('\\n')[0],
          lastNonBlankLine: transcript.value.split('\\n').filter(line => line.trim()).at(-1),
          summary: summary.textContent
        };
      })()`),
      '5000 行 TXT 載入完成'
    );

    await client.evaluate(`(() => {
      const input = document.getElementById('asrTranscriptFileInput');
      input.click = window.__txtImportNativeClick;
      const transcript = document.getElementById('asrTranscript');
      transcript.focus();
      transcript.setSelectionRange(transcript.value.length, transcript.value.length);
      return true;
    })()`);
    await client.send('Input.insertText', { text: '手動新增的一行' });
    imported.summaryHiddenAfterEdit = await waitFor(
      () => client.evaluate("getComputedStyle(document.getElementById('asrTranscriptFileSummary')).display === 'none'"),
      '手動編輯後隱藏過時摘要'
    );

    if (imported.mode !== 'align' || imported.rowDisplay !== 'flex' || !imported.buttonVisible ||
        imported.buttonText !== '匯入 TXT' || imported.fileName !== 'many-lines.txt' ||
        imported.importedLineCount !== 5000 || imported.firstLine !== '  Line 1.  ' ||
        imported.lastNonBlankLine !== 'Line 5000.' || !imported.summaryHiddenAfterEdit) {
      throw new Error(`TXT 匯入真機驗收失敗：${JSON.stringify(imported)}`);
    }
    console.log(JSON.stringify(imported, null, 2));
  } finally {
    client?.close();
    if (child.exitCode === null) child.kill('SIGKILL');
    await Promise.race([new Promise(resolve => child.once('close', resolve)), delay(5000)]);
    verifiedCleanup(profileDir);
  }
})().catch(error => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
