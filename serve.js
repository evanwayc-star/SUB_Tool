/* SUB Tool 本機伺服器（支援 HTTP Range，影片可正確跳轉；並設定 CORS）
   用途：以本機伺服器開啟工具，讓 ffmpeg.wasm 與「線上串流影片跳轉」更穩定。
   一般情況直接雙擊 index.html 即可使用；此伺服器為進階/相容性選項。
   執行： node serve.js   然後瀏覽器開 http://localhost:8777/ */
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 8777;
const ROOT = __dirname;
const MIME = {
  '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8',
  '.mp4':'video/mp4', '.mov':'video/quicktime', '.mkv':'video/x-matroska',
  '.webm':'video/webm', '.mp3':'audio/mpeg', '.wav':'audio/wav',
  '.m4a':'audio/mp4', '.aac':'audio/aac', '.ogg':'audio/ogg', '.flac':'audio/flac',
  '.srt':'text/plain; charset=utf-8', '.ass':'text/plain; charset=utf-8',
  '.txt':'text/plain; charset=utf-8', '.subtool':'application/json',
  '.png':'image/png', '.jpg':'image/jpeg', '.svg':'image/svg+xml', '.wasm':'application/wasm',
};

http.createServer((req, res) => {
  let p = decodeURIComponent(url.parse(req.url).pathname);
  if (p === '/' || p === '') p = '/index.html';
  const file = path.join(ROOT, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(ROOT)) { res.writeHead(403).end('Forbidden'); return; }

  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404).end('Not Found'); return; }
    const ext = path.extname(file).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    const headers = {
      'Content-Type': type,
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache',
    };
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = m[1] ? parseInt(m[1], 10) : 0;
      let end = m[2] ? parseInt(m[2], 10) : st.size - 1;
      if (isNaN(start)) start = 0;
      if (isNaN(end) || end >= st.size) end = st.size - 1;
      if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }).end(); return; }
      headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
      headers['Content-Length'] = end - start + 1;
      res.writeHead(206, headers);
      fs.createReadStream(file, { start, end }).pipe(res);
    } else {
      headers['Content-Length'] = st.size;
      res.writeHead(200, headers);
      fs.createReadStream(file).pipe(res);
    }
  });
}).listen(PORT, () => {
  console.log(`\n  SUB Tool 伺服器已啟動 (支援影片跳轉)`);
  console.log(`  請用瀏覽器開啟： http://localhost:${PORT}/\n  按 Ctrl+C 結束。\n`);
});
