/* ============================================================================
   音訊辨識／文本匹配 UI —— Electron / CDP 真機驗收
   ============================================================================
   先執行 npm run build，再執行：
     node scripts/acceptance/verify-speech-recognition-ui.js

   以真實右鍵與滑鼠點擊開啟對話框，驗證寬版雙欄、文本匹配互動、
   無障礙語意與 620px 窄版單欄；截圖輸出至系統暫存目錄。
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
  verifiedCleanup
} = require('./cdp-electron-harness.js');

async function capture(client, outputPath) {
  const screenshot = await client.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false
  });
  fs.writeFileSync(outputPath, Buffer.from(screenshot.data, 'base64'));
}

(async () => {
  if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) {
    throw new Error('找不到 dist/index.html，請先執行 npm run build');
  }
  const profileDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-asr-ui-cdp-'));
  const wideScreenshot = path.join(os.tmpdir(), 'subtool-asr-ui-wide.png');
  const alignScreenshot = path.join(os.tmpdir(), 'subtool-asr-ui-align.png');
  const narrowScreenshot = path.join(os.tmpdir(), 'subtool-asr-ui-narrow.png');
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
    await client.send('Page.enable');
    await client.send('Page.bringToFront');

    await client.evaluate(`(() => {
      localStorage.setItem('subtool_asr_config', JSON.stringify({
        taskMode: 'transcribe', provider: 'google', builtinModel: 'onnx-community/whisper-large-v3-turbo',
        googleApiKey: '', groqApiKey: '', openaiApiKey: '', azureApiKey: '', elevenlabsApiKey: '',
        azureRegion: 'japaneast', azurePhraseList: '', elevenlabsKeyterms: '', language: 'zh', prompt: ''
      }));
      window.SUB.State.clips = [{
        id: 'asr-ui-source', name: 'Interview_Dialogue_Traditional_Chinese.wav', type: 'video',
        offset: 0, in: 0, out: 65, dur: 65, duration: 65, vtrack: 0,
        audioSourceId: 'asr-ui-audio', audioSrc: 'asr-ui-audio', primary: true,
        recognitionTracks: [
          { sourceStream: 0, sourceChannel: 0, el: { src: 'blob:asr-ui-dialogue-left' } },
          { sourceStream: 1, sourceChannel: 0, el: { src: 'blob:asr-ui-dialogue-right' } }
        ]
      }];
      window.SUB.State.duration = 65;
      window.SUB.State.viewStart = 0;
      window.SUB.State.pxPerSec = 9;
      window.SUB.Media.sourceChannels = () => [
        { sourceStream: 0, sourceChannel: 0, el: { src: 'blob:asr-ui-dialogue-left' } },
        { sourceStream: 1, sourceChannel: 0, el: { src: 'blob:asr-ui-dialogue-right' } }
      ];
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
      () => client.evaluate("Boolean(document.querySelector('.asr-config-workspace'))"),
      '音訊辨識設定視窗'
    );
    await delay(180);

    const wide = await client.evaluate(`(() => {
      const modal = document.querySelector('#modalBg .modal');
      const grid = document.querySelector('.asr-settings-grid');
      const status = document.getElementById('asrStatus');
      const modeButtons = [...document.querySelectorAll('.asr-mode-option')];
      const engineCard = document.querySelector('.asr-engine-card');
      const rect = modal.getBoundingClientRect();
      return {
        viewport: { width: innerWidth, height: innerHeight },
        modal: { width: rect.width, height: rect.height, left: rect.left, top: rect.top },
        gridColumns: getComputedStyle(grid).gridTemplateColumns,
        modeButtonMinHeight: Math.min(...modeButtons.map(button => button.getBoundingClientRect().height)),
        activeMode: modeButtons.find(button => button.getAttribute('aria-pressed') === 'true')?.dataset.asrMode,
        sourceSelectorParent: document.getElementById('asrRecognitionAudioSourceRow').parentElement.className,
        contentDisplay: getComputedStyle(document.getElementById('asrContentCard')).display,
        engineWidth: engineCard.getBoundingClientRect().width,
        hasRedundantModeHeading: Boolean(document.querySelector('.asr-mode-heading')),
        hasRedundantSummary: Boolean(document.getElementById('asrTranscribeSummary')),
        statusLive: status.getAttribute('aria-live'),
        labelledFields: ['asrTranscript', 'asrProvider', 'asrApiKey', 'asrLanguage'].every(id =>
          Boolean(document.querySelector('label[for="' + id + '"]'))),
        horizontalOverflow: document.querySelector('.asr-workspace').scrollWidth > document.querySelector('.asr-workspace').clientWidth
      };
    })()`);
    await capture(client, wideScreenshot);

    const alignButtonRect = await client.evaluate(`(() => {
      const element = document.getElementById('asrModeAlign');
      const rect = element.getBoundingClientRect();
      return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    })()`);
    await dispatchClick(client, alignButtonRect);
    await client.evaluate(`(() => {
      const transcript = document.getElementById('asrTranscript');
      transcript.value = '第一行字幕。\\n\\n第二行字幕。\\n第三行字幕。';
      transcript.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    const align = await waitFor(
      () => client.evaluate(`(() => {
        const row = document.getElementById('asrTranscriptRow');
        const button = document.getElementById('asrModeAlign');
        if (button.getAttribute('aria-pressed') !== 'true') return null;
        return {
          taskMode: document.getElementById('asrTaskMode').value,
          transcriptDisplay: getComputedStyle(row).display,
          contentDisplay: getComputedStyle(document.getElementById('asrContentCard')).display,
          lineCount: document.getElementById('asrTranscriptLineCount').textContent.trim(),
          target: document.getElementById('asrTargetSummary').value,
          primaryAction: document.querySelector('#modalFoot button.primary').textContent.trim()
        };
      })()`),
      '文本匹配模式切換'
    );
    await delay(120);
    await capture(client, alignScreenshot);

    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 620,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false
    });
    await delay(180);
    const narrow = await client.evaluate(`(() => {
      const workspace = document.querySelector('.asr-workspace');
      const grid = document.querySelector('.asr-settings-grid');
      const modal = document.querySelector('#modalBg .modal');
      return {
        viewport: { width: innerWidth, height: innerHeight },
        modalWidth: modal.getBoundingClientRect().width,
        gridColumns: getComputedStyle(grid).gridTemplateColumns,
        horizontalOverflow: workspace.scrollWidth > workspace.clientWidth,
        footerVisible: document.getElementById('modalFoot').getBoundingClientRect().bottom <= innerHeight + 1
      };
    })()`);
    await capture(client, narrowScreenshot);
    await client.send('Emulation.clearDeviceMetricsOverride');

    if (wide.modal.width < 760 || wide.activeMode !== 'transcribe' || wide.statusLive !== 'polite' ||
        !wide.sourceSelectorParent.includes('asr-source-card') || wide.contentDisplay !== 'none' ||
        wide.engineWidth < 760 || wide.hasRedundantModeHeading || wide.hasRedundantSummary ||
        !wide.labelledFields || wide.horizontalOverflow || wide.modeButtonMinHeight < 58 ||
        align.taskMode !== 'align' || align.transcriptDisplay !== 'flex' || align.contentDisplay !== 'flex' || align.lineCount !== '3 行' ||
        !align.target.includes('文本匹配') || align.primaryAction !== '開始匹配' ||
        narrow.horizontalOverflow || !narrow.footerVisible || narrow.modalWidth > 620) {
      throw new Error(`ASR UI 真機驗收失敗：${JSON.stringify({ wide, align, narrow })}`);
    }

    console.log(JSON.stringify({ wide, align, narrow, screenshots: { wideScreenshot, alignScreenshot, narrowScreenshot } }, null, 2));
  } finally {
    client?.close();
    if (child.exitCode === null) child.kill('SIGKILL');
    await Promise.race([new Promise(resolve => child.once('close', resolve)), delay(5000)]);
    verifiedCleanup(profileDir, 'subtool-asr-ui-cdp-');
  }
})().catch(error => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
