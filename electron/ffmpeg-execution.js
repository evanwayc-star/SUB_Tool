/* ==============================================================================
   SUB Tool — FFmpeg Execution Adapter
   ==============================================================================
   核心實作已深化至 electron/ffmpeg-execution-engine.js。
   ============================================================================== */
'use strict';

const {
  FFmpegErrorAnalyzer,
  FFmpegOutputParser,
} = require('./ffmpeg-parser');
const { createFFmpegExecution } = require('./ffmpeg-execution-engine');

module.exports = {
  createFFmpegExecution,
  FFmpegErrorAnalyzer,
  FFmpegOutputParser,
};
