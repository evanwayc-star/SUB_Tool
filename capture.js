const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({
    defaultViewport: { width: 1200, height: 800 },
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  
  // 1. Capture Workspace
  await page.goto('http://localhost:8777/');
  await page.evaluate(() => {
    // Modify state to add some fake data
    if (window.State && window.Seq) {
      window.State.tracks = [{name:'對白',visible:true,locked:false}, {name:'歌詞',visible:true,locked:false}];
      window.State.videoTracks = [{name:'V_拼桌_FTR_24FPS_51FM+20FM_30P.mxf',visible:true,locked:false}, {name:'視訊軌 2',visible:true,locked:false}];
      window.State.cues = [
        {id: '1', start: 1.5, end: 4.2, text: '這是一個強大的多軌時間軸字幕工具', track: 0, style: { fontSize: 45, color: '#ffffff' }},
        {id: '2', start: 4.5, end: 8.0, text: '可以精準處理每一句字幕的外觀與時碼', track: 0},
        {id: '3', start: 2.0, end: 6.0, text: '♫ 背景音樂 ♫', track: 1}
      ];
      window.State.clips = [
        {id: 'c1', start: 0, end: 10, offset: 0, vtrack: 0, name: 'V_拼桌_FTR_24FPS_51FM+20FM_30P.mxf'}
      ];
      window.State.duration = 15;
      if (window.drawTimeline) window.drawTimeline();
      if (window.renderSublist) window.renderSublist();
      if (window.renderTrackGutter) window.renderTrackGutter();
      if (window.renderVtrackGutter) window.renderVtrackGutter();
    }
  });
  await new Promise(r => setTimeout(r, 1000)); // Wait for rendering
  await page.screenshot({ path: 'docs/images/readme-workspace.png' });

  // 2. Capture Export Queue
  await page.goto('http://localhost:8777/electron/queue.html');
  await page.evaluate(() => {
    // Fake queue data
    if (window.jobs) {
      window.jobs = [
        {id: '1', fileName: '合併_對白+歌詞.srt', status: 'completed', duration: 1800, progress: 100, startTime: Date.now() - 60000, endTime: Date.now() - 5000, message: '匯出完成'},
        {id: '2', fileName: 'ST_V_SUB_拼桌.mp4', status: 'processing', duration: 3600, progress: 45, startTime: Date.now() - 20000, message: '寫入影片中... (速度: 2.5x)'},
        {id: '3', fileName: 'ST_V_SUB_對白.ass', status: 'waiting', duration: 1800, progress: 0, startTime: null}
      ];
      if (window.renderQueue) window.renderQueue();
    }
  });
  await new Promise(r => setTimeout(r, 1000));
  await page.screenshot({ path: 'docs/images/readme-export-queue.png' });

  await browser.close();
})();
