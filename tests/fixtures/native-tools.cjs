const path = require('node:path');

/* CI stores each verified tool outside the checkout. Keep their paths independent;
   local runs without overrides can still use the packaged Windows binaries. */
function nativeTestTools({ env = process.env, root = path.resolve(__dirname, '../..') } = {}) {
  return {
    ffmpeg: env.FFMPEG_PATH || path.join(root, 'electron', 'ffmpeg', 'ffmpeg.exe'),
    ffprobe: env.FFPROBE_PATH || path.join(root, 'electron', 'ffmpeg', 'ffprobe.exe'),
  };
}

module.exports = { nativeTestTools };
