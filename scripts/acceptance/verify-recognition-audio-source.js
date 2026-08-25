/* ============================================================================
   辨識音訊來源 —— Electron / CDP 真機驗收
   ============================================================================
   先執行 npm run build，再執行：
     node scripts/acceptance/verify-recognition-audio-source.js

   使用獨立 user-data-dir 與假的 Groq fetch；不會連線、不碰正式設定。
   ============================================================================ */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const {
  ROOT,
  ELECTRON,
  delay,
  reservePort,
  getJSON,
  waitFor,
  CdpClient,
  dispatchClick,
  dispatchKey,
  verifiedCleanup
} = require('./cdp-electron-harness.js');

(async () => {
  if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) {
    throw new Error('找不到 dist/index.html，請先執行 npm run build');
  }
  const profileDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-asr-source-cdp-'));
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
    await client.send('Page.bringToFront');

    await client.evaluate(`(() => {
      const patterns = [
        [0, 0.8], [0.8, 0.8], [0.8, 0], [0.8, -0.8],
        [0, 0], [0, 0], [0.8, 0], [0, 0.8]
      ];
      window.SUB.State.clips = [{
        id: 'asr-source-cdp-clip', name: 'asr-source-cdp.wav', type: 'video',
        offset: 0, in: 0, out: 2, dur: 2, duration: 2, vtrack: 0,
        audioSourceId: 'asr-source-cdp-audio', audioSrc: 'asr-source-cdp-audio', primary: true
      }];
      window.SUB.State.cues = [];
      window.SUB.State.duration = 2;
      window.SUB.State.viewStart = 0;
      window.SUB.State.pxPerSec = 200;
      window.SUB.Media.tracks = patterns.map((pattern, sourceStream) => ({
        id: 'asr-source-' + sourceStream,
        kind: 'buffer',
        source: 'asr-source-cdp-audio',
        sourceStream,
        sourceChannel: 0,
        buffer: {
          sampleRate: 16000,
          numberOfChannels: 1,
          length: 2,
          duration: 2 / 16000,
          getChannelData: channel => {
            if (channel !== 0) throw new RangeError('mono');
            return new Float32Array(pattern);
          }
        }
      }));
      window.__asrOriginalFetch = window.fetch;
      window.__asrResponseMode = 'success';
      window.__asrCapturedWav = null;
      window.fetch = async (url, options = {}) => {
        if (String(url).includes('api.groq.com/openai/v1/audio/transcriptions')) {
          const wav = options.body.get('file');
          const bytes = await wav.arrayBuffer();
          const view = new DataView(bytes);
          window.__asrCapturedWav = {
            byteLength: bytes.byteLength,
            firstPcmSamples: [view.getInt16(44, true), view.getInt16(46, true)]
          };
          const mismatch = window.__asrResponseMode === 'mismatch';
          const recovered = window.__asrResponseMode === 'recovered';
          const recoveredLines = Array.from({ length: 20 }, (_, index) => (
            index === 10 ? 'missing phrase' : ('anchor' + index + ' a b c d e f g h i')
          ));
          const recoveredPayload = {
            text: recoveredLines.filter((_, index) => index !== 10).join(' '),
            segments: recoveredLines.flatMap((text, index) => (
              index === 10 ? [] : [{ start: index * 2, end: (index * 2) + 1, text }]
            ))
          };
          return new Response(JSON.stringify(mismatch ? {
            text: 'alpha wrong gamma other',
            segments: [{ start: 0, end: 1, text: 'alpha wrong gamma other' }]
          } : recovered ? recoveredPayload : {
            text: '來源聲道三',
            segments: [{ start: 0, end: 1, text: '來源聲道三' }]
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return window.__asrOriginalFetch(url, options);
      };
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
      '八軌音訊素材區塊'
    );
    const openRecognitionDialog = async () => {
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
    };
    await openRecognitionDialog();

    const dialog = await waitFor(
      () => client.evaluate(`(() => {
        const select = document.getElementById('asrRecognitionAudioSource');
        if (!select || select.options.length !== 10) return null;
        return {
          options: [...select.options].map(option => option.textContent.trim()),
          help: document.getElementById('asrRecognitionAudioSourceRow').textContent.replace(/\s+/gu, ' ').trim()
        };
      })()`),
      '八軌辨識來源選單'
    );

    await client.evaluate(`(() => {
      const provider = document.getElementById('asrProvider');
      provider.value = 'groq';
      provider.dispatchEvent(new Event('change', { bubbles: true }));
      document.getElementById('asrApiKey').value = 'acceptance-only-key';
      return true;
    })()`);

    const sourceRect = await client.evaluate(`(() => {
      const element = document.getElementById('asrRecognitionAudioSource');
      const rect = element.getBoundingClientRect();
      return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    })()`);
    await dispatchClick(client, sourceRect);
    await dispatchKey(client, 'Home');
    for (let index = 0; index < 4; index++) await dispatchKey(client, 'ArrowDown');
    await dispatchKey(client, 'Enter');
    await waitFor(
      () => client.evaluate("document.getElementById('asrRecognitionAudioSource').selectedOptions[0].textContent.trim() === '來源聲道 3'"),
      '真實鍵盤選取來源聲道 3'
    );

    const startRect = await client.evaluate(`(() => {
      const element = document.querySelector('#modalFoot button.primary');
      const rect = element.getBoundingClientRect();
      return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    })()`);
    await dispatchClick(client, startRect);

    const result = await waitFor(
      () => client.evaluate(`(() => {
        if (!window.__asrCapturedWav) return null;
        const cue = window.SUB.State.cues.find(item => item.text === '來源聲道三');
        if (!cue) return null;
        return {
          ...window.__asrCapturedWav,
          cueText: cue.text,
          trackName: window.SUB.State.tracks[cue.track]?.name || '',
          fetchRestored: false
        };
      })()`),
      '來源聲道 3 的 WAV 送到 provider 邊界'
    );
    await waitFor(
      () => client.evaluate("!document.getElementById('modalBg').classList.contains('show')"),
      '第一次辨識視窗關閉'
    );
    await client.evaluate(`(() => {
      window.__asrResponseMode = 'mismatch';
      window.__asrCapturedWav = null;
      return true;
    })()`);
    await openRecognitionDialog();
    await waitFor(
      () => client.evaluate("Boolean(document.getElementById('asrProvider'))"),
      '第二次文本匹配視窗'
    );
    const cueCountBeforeDiagnostic = await client.evaluate('window.SUB.State.cues.length');
    await client.evaluate(`(() => {
      const provider = document.getElementById('asrProvider');
      provider.value = 'groq';
      provider.dispatchEvent(new Event('change', { bubbles: true }));
      document.getElementById('asrApiKey').value = 'acceptance-only-key';
      const task = document.getElementById('asrTaskMode');
      task.value = 'align';
      task.dispatchEvent(new Event('change', { bubbles: true }));
      document.getElementById('asrTranscript').value = 'alpha beta\\ngamma delta';
      return true;
    })()`);
    const diagnosticStartRect = await client.evaluate(`(() => {
      const element = document.querySelector('#modalFoot button.primary');
      const rect = element.getBoundingClientRect();
      return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    })()`);
    await dispatchClick(client, diagnosticStartRect);
    result.diagnostic = await waitFor(
      () => client.evaluate(`(() => {
        const panel = document.getElementById('asrAlignmentDiagnostic');
        const lines = document.getElementById('asrUnreliableLineNumbers');
        const button = document.getElementById('asrDownloadAlignmentDiagnostic');
        if (!panel || getComputedStyle(panel).display === 'none') return null;
        const rect = button.getBoundingClientRect();
        return {
          lines: lines.textContent.trim(),
          warning: panel.textContent.replace(/\\s+/gu, ' ').trim(),
          downloadVisible: rect.width > 0 && rect.height > 0,
          cueCount: window.SUB.State.cues.length
        };
      })()`),
      '低覆蓋失敗行號與診斷面板'
    );
    await client.evaluate(`(() => {
      window.__diagnosticDownloadBlob = null;
      window.__diagnosticDownloadName = '';
      window.__diagnosticDownloadClickCount = 0;
      window.__diagnosticOriginalCreateObjectURL = URL.createObjectURL;
      window.__diagnosticOriginalAnchorClick = HTMLAnchorElement.prototype.click;
      window.__diagnosticDownloadClickListener = () => {
        window.__diagnosticDownloadClickCount += 1;
      };
      document.getElementById('asrDownloadAlignmentDiagnostic')
        .addEventListener('click', window.__diagnosticDownloadClickListener, true);
      URL.createObjectURL = blob => {
        window.__diagnosticDownloadBlob = blob;
        return window.__diagnosticOriginalCreateObjectURL.call(URL, blob);
      };
      HTMLAnchorElement.prototype.click = function click() {
        window.__diagnosticDownloadName = this.download;
      };
      return true;
    })()`);
    await client.evaluate(`(async () => {
      document.getElementById('asrDownloadAlignmentDiagnostic')
        .scrollIntoView({ block: 'center', inline: 'nearest' });
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return true;
    })()`);
    const readDiagnosticDownload = () => client.evaluate(`(async () => {
        const blob = window.__diagnosticDownloadBlob;
        if (!blob || !window.__diagnosticDownloadName) return null;
        const serialized = await blob.text();
        const parsed = JSON.parse(serialized);
        const forbidden = [
          'acceptance-only-key', 'asr-source-cdp.wav', 'api.groq.com',
          'audioBuffer', 'audioBlob', 'Authorization', 'headers'
        ].filter(value => serialized.includes(value));
        return {
          name: window.__diagnosticDownloadName,
          type: blob.type,
          lineNumbers: parsed.unreliableLines.map(line => line.lineNumber),
          reasons: parsed.unreliableLines.map(line => line.reasons),
          transcriptLines: parsed.transcriptLines,
          audioSelection: parsed.audioSelection,
          forbidden
        };
      })()`);
    let diagnosticDownload = null;
    let downloadClickAttempts = 0;
    while (!diagnosticDownload && downloadClickAttempts < 3) {
      const downloadRect = await waitFor(
        () => client.evaluate(`(() => {
          const element = document.getElementById('asrDownloadAlignmentDiagnostic');
          const rect = element.getBoundingClientRect();
          const x = rect.left + Math.min(20, rect.width / 2);
          const y = rect.top + Math.min(10, rect.height / 2);
          const hit = document.elementFromPoint(x, y);
          if (rect.bottom <= 0 || rect.top >= innerHeight || (hit !== element && !element.contains(hit))) return null;
          return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
        })()`),
        '診斷下載按鈕可見且可命中'
      );
      const clickCountBefore = await client.evaluate('window.__diagnosticDownloadClickCount');
      downloadClickAttempts += 1;
      await dispatchClick(client, downloadRect);
      try {
        diagnosticDownload = await waitFor(
          readDiagnosticDownload,
          '真實點擊後的診斷 JSON 內容',
          1500
        );
      } catch (error) {
        const clickCountAfter = await client.evaluate('window.__diagnosticDownloadClickCount');
        if (clickCountAfter > clickCountBefore) {
          throw new Error(`診斷下載按鈕已收到 click，但未產生 JSON：${error.message}`);
        }
      }
    }
    if (!diagnosticDownload) {
      throw new Error(`診斷下載按鈕連續 ${downloadClickAttempts} 次未收到 CDP click`);
    }
    result.diagnostic.download = diagnosticDownload;
    result.diagnostic.downloadClickAttempts = downloadClickAttempts;
    await client.evaluate(`(() => {
      document.getElementById('asrDownloadAlignmentDiagnostic')
        ?.removeEventListener('click', window.__diagnosticDownloadClickListener, true);
      URL.createObjectURL = window.__diagnosticOriginalCreateObjectURL;
      HTMLAnchorElement.prototype.click = window.__diagnosticOriginalAnchorClick;
      delete window.__diagnosticDownloadClickListener;
      delete window.__diagnosticDownloadClickCount;
      delete window.__diagnosticOriginalCreateObjectURL;
      delete window.__diagnosticOriginalAnchorClick;
      return true;
    })()`);
    const failedCloseRect = await client.evaluate(`(() => {
      const element = [...document.querySelectorAll('#modalFoot button')]
        .find(button => !button.classList.contains('primary'));
      const rect = element.getBoundingClientRect();
      return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    })()`);
    await dispatchClick(client, failedCloseRect);
    await waitFor(
      () => client.evaluate("!document.getElementById('modalBg').classList.contains('show')"),
      '低覆蓋診斷視窗關閉'
    );
    await client.evaluate(`(() => {
      window.__asrResponseMode = 'recovered';
      window.__asrCapturedWav = null;
      return true;
    })()`);
    await openRecognitionDialog();
    await waitFor(
      () => client.evaluate("Boolean(document.getElementById('asrProvider'))"),
      '第三次稀疏漏句恢復視窗'
    );
    await client.evaluate(`(() => {
      const provider = document.getElementById('asrProvider');
      provider.value = 'groq';
      provider.dispatchEvent(new Event('change', { bubbles: true }));
      document.getElementById('asrApiKey').value = 'acceptance-only-key';
      const task = document.getElementById('asrTaskMode');
      task.value = 'align';
      task.dispatchEvent(new Event('change', { bubbles: true }));
      document.getElementById('asrTranscript').value = Array.from({ length: 20 }, (_, index) => (
        index === 10 ? 'missing phrase' : ('anchor' + index + ' a b c d e f g h i')
      )).join('\\n');
      return true;
    })()`);
    const recoveredStartRect = await client.evaluate(`(() => {
      const element = document.querySelector('#modalFoot button.primary');
      const rect = element.getBoundingClientRect();
      return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    })()`);
    await dispatchClick(client, recoveredStartRect);
    result.recovered = await waitFor(
      () => client.evaluate(`(() => {
        const panel = document.getElementById('asrAlignmentDiagnostic');
        const status = document.getElementById('asrStatus');
        const lines = document.getElementById('asrUnreliableLineNumbers');
        const buttons = [...document.querySelectorAll('#modalFoot button')];
        const primary = buttons.find(button => button.classList.contains('primary'));
        const close = buttons.find(button => !button.classList.contains('primary'));
        const expectedLines = Array.from({ length: 20 }, (_, index) => (
          index === 10 ? 'missing phrase' : ('anchor' + index + ' a b c d e f g h i')
        ));
        const cues = window.SUB.State.cues.filter(cue => expectedLines.includes(cue.text));
        if (cues.length !== 20 || !panel || getComputedStyle(panel).display === 'none') return null;
        return {
          cueTexts: cues.map(cue => cue.text),
          trackName: window.SUB.State.tracks[cues[0].track]?.name || '',
          status: status.textContent.trim(),
          lines: lines.textContent.trim(),
          primaryText: primary?.textContent.trim(),
          primaryDisabled: primary?.disabled === true,
          closeText: close?.textContent.trim(),
          modalVisible: document.getElementById('modalBg').classList.contains('show')
        };
      })()`),
      '稀疏漏句建立完整初稿並保留診斷視窗'
    );
    await client.evaluate(`(() => {
      window.fetch = window.__asrOriginalFetch;
      delete window.__asrOriginalFetch;
      return true;
    })()`);
    result.fetchRestored = true;
    result.options = dialog.options;
    result.help = dialog.help;

    const expectedOptions = [
      '全部來源聲道混音（8 軌）',
      '最後兩軌組（來源聲道 7 + 8）',
      '來源聲道 1', '來源聲道 2', '來源聲道 3', '來源聲道 4',
      '來源聲道 5', '來源聲道 6', '來源聲道 7', '來源聲道 8'
    ];
    const expectedRecoveredTexts = Array.from({ length: 20 }, (_, index) => (
      index === 10 ? 'missing phrase' : `anchor${index} a b c d e f g h i`
    ));
    if (JSON.stringify(result.options) !== JSON.stringify(expectedOptions) ||
        JSON.stringify(result.firstPcmSamples) !== JSON.stringify([31128, 0]) ||
        result.cueText !== '來源聲道三' || result.trackName !== '語音辨識' ||
        !result.help.includes('逐來源聲道等權平均') || !result.fetchRestored ||
        !result.diagnostic.lines.includes('第 1、2 行') ||
        !result.diagnostic.warning.includes('完整稿件') || !result.diagnostic.downloadVisible ||
        result.diagnostic.cueCount !== cueCountBeforeDiagnostic ||
        !/^SUBTool_文本匹配診斷_.*\.json$/u.test(result.diagnostic.download.name) ||
        result.diagnostic.download.type !== 'application/json' ||
        JSON.stringify(result.diagnostic.download.lineNumbers) !== JSON.stringify([1, 2]) ||
        JSON.stringify(result.diagnostic.download.transcriptLines) !== JSON.stringify(['alpha beta', 'gamma delta']) ||
        result.diagnostic.download.audioSelection?.mode !== 'all-source-channels' ||
        result.diagnostic.download.forbidden.length !== 0 ||
        !result.diagnostic.download.reasons.every(reasons => reasons.includes('low-coverage')) ||
        JSON.stringify(result.recovered.cueTexts) !== JSON.stringify(expectedRecoveredTexts) ||
        result.recovered.trackName !== '文本匹配' ||
        !result.recovered.status.includes('1 行使用推估時間') ||
        !result.recovered.status.includes('共 20 行需人工校對') ||
        !result.recovered.status.includes('不是精準對齊') ||
        !result.recovered.lines.includes('第 1、2') ||
        !result.recovered.lines.includes('、11、') ||
        !result.recovered.lines.includes('20 行') ||
        result.recovered.primaryText !== '已建立' || !result.recovered.primaryDisabled ||
        result.recovered.closeText !== '關閉' || !result.recovered.modalVisible) {
      throw new Error(`辨識來源真機驗收失敗：${JSON.stringify(result)}`);
    }
    console.log(JSON.stringify(result, null, 2));
  } finally {
    if (client) {
      await client.evaluate(`(() => {
        if (window.__asrOriginalFetch) window.fetch = window.__asrOriginalFetch;
        if (window.__diagnosticOriginalCreateObjectURL) {
          URL.createObjectURL = window.__diagnosticOriginalCreateObjectURL;
        }
        if (window.__diagnosticOriginalAnchorClick) {
          HTMLAnchorElement.prototype.click = window.__diagnosticOriginalAnchorClick;
        }
        return true;
      })()`).catch(() => {});
    }
    client?.close();
    if (child.exitCode === null) child.kill('SIGKILL');
    await Promise.race([new Promise(resolve => child.once('close', resolve)), delay(5000)]);
    verifiedCleanup(profileDir, 'subtool-asr-source-cdp-');
  }
})().catch(error => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
