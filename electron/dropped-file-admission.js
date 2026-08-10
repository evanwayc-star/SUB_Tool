'use strict';

const path = require('path');
const { PROJECT_FILE } = require('./file-authority');

function isProjectFilePath(filePath) {
  return typeof filePath === 'string' && PROJECT_FILE.test(filePath);
}

function authorizeDroppedMediaPath(filePath, {
  grantRead,
  grantScreenshotDirectory,
  pathModule = path,
} = {}) {
  if (typeof filePath !== 'string' || !filePath || isProjectFilePath(filePath)) return null;
  if (typeof grantRead !== 'function' || !grantRead(filePath)) return null;
  if (typeof grantScreenshotDirectory === 'function') grantScreenshotDirectory(pathModule.dirname(filePath));
  return filePath;
}

module.exports = { authorizeDroppedMediaPath };
