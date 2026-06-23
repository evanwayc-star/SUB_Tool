const cp = require('child_process');
const fs = require('fs');
const src = '參考資料/影音檔案樣本/Story Of My Wife_FTR_24p_51FM.wav';
const out = 'test_out.wav';
try {
  cp.execSync('ffmpeg -y -i "' + src + '" -map 0:a:0 -ar 4000 -c:a pcm_s16le "' + out + '"', { stdio: 'pipe' });
  console.log('ffmpeg success, file size:', fs.statSync(out).size);
} catch (e) {
  console.log('ffmpeg failed:', e.message);
  console.log('stdout:', e.stdout ? e.stdout.toString() : '');
  console.log('stderr:', e.stderr ? e.stderr.toString() : '');
}
