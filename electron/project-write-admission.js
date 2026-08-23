/* ==============================================================================
   SUB Tool — Project Write Admission Adapter
   ==============================================================================
   核心實作已深化至 electron/project-file-authority-engine.js。
   ============================================================================== */
'use strict';

const {
  commitAdmittedProjectWrite,
  finalizeProjectWrite,
  inspectProjectWrite,
} = require('./project-file-authority-engine');

module.exports = {
  commitAdmittedProjectWrite,
  finalizeProjectWrite,
  inspectProjectWrite,
};
