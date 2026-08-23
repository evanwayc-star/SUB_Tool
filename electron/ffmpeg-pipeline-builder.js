/* ==============================================================================
   SUB Tool — FFmpeg Pipeline Builder Adapter
   ==============================================================================
   核心實作已深化至 electron/ffmpeg-execution-engine.js。
   ============================================================================== */
'use strict';

const { buildIngestArgs } = require('./ffmpeg-execution-engine');

module.exports = { buildIngestArgs };
