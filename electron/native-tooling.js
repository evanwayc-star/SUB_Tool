/* ==============================================================================
   SUB Tool — Native Tooling Adapter
   ==============================================================================
   核心實作已深化至 electron/ffmpeg-execution-engine.js。
   ============================================================================== */
'use strict';

const {
  bundledNativeRequirements,
  deliveryVideoEncoderArgs,
  detectNativeTool,
  mpvEmbeddingSupported,
  nativeToolCandidates,
  previewVideoEncoderArgs,
  videoEncoderCandidates,
} = require('./ffmpeg-execution-engine');

module.exports = {
  bundledNativeRequirements,
  deliveryVideoEncoderArgs,
  detectNativeTool,
  mpvEmbeddingSupported,
  nativeToolCandidates,
  previewVideoEncoderArgs,
  videoEncoderCandidates,
};
