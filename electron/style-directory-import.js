'use strict';

const fs = require('node:fs');
const path = require('node:path');

// 樣式匯入的名稱必須保留相對資料夾，供 renderer 重建樣式群組。
function collectStyleDirectoryFiles(root, { fsModule = fs, pathModule = path } = {}) {
  const files = [];
  function scan(directory) {
    for (const name of fsModule.readdirSync(directory)) {
      const file = pathModule.join(directory, name);
      const entry = fsModule.lstatSync(file);
      // Junction／symlink 不屬於使用者選取的實體目錄；也不能藉此形成遞迴環。
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) scan(file);
      else if (entry.isFile() && name.endsWith('.json')) {
        files.push({
          name: pathModule.relative(root, file).split(pathModule.sep).join('/'),
          b64: fsModule.readFileSync(file).toString('base64'),
        });
      }
    }
  }
  scan(root);
  return files;
}

module.exports = { collectStyleDirectoryFiles };
