/* ==============================================================================
   SUB Tool — FFmpeg Parser Adapter
   ==============================================================================
   核心實作已深化至 electron/ffmpeg-execution-engine.js。
   ============================================================================== */
'use strict';

const {
  FFmpegErrorAnalyzer,
  FFmpegOutputParser,
} = require('./ffmpeg-execution-engine');

module.exports = {
  FFmpegErrorAnalyzer,
  FFmpegOutputParser,
};
