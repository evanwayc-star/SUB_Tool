/* ==============================================================================
   SUB Tool — Dropped File Admission Adapter
   ==============================================================================
   核心實作已深化至 electron/project-file-authority-engine.js。
   ============================================================================== */
'use strict';

const {
  authorizeDroppedMediaPath,
  isProjectFilePath,
} = require('./project-file-authority-engine');

module.exports = {
  authorizeDroppedMediaPath,
  isProjectFilePath,
};
