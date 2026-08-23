/* ==============================================================================
   SUB Tool — Project Workspace Adapter
   ==============================================================================
   核心實作已深化至 electron/project-file-authority-engine.js。
   ============================================================================== */
'use strict';

const { createTrustedProjectIntake } = require('./trusted-project-intake');
const { commitAdmittedProjectWrite, inspectProjectWrite } = require('./project-write-admission');
const { createProjectWorkspace } = require('./project-file-authority-engine');

module.exports = {
  commitAdmittedProjectWrite,
  createProjectWorkspace,
  createTrustedProjectIntake,
  inspectProjectWrite,
};
