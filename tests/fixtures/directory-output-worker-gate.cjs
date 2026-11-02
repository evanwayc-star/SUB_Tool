'use strict';

// Injected only into this regression's Worker. Pause after the destination
// check, immediately before the staged output's final content read.
const { isMainThread, workerData } = require('node:worker_threads');
if (!isMainThread && workerData?.task === 'directory-output') {
  const fs = require('node:fs');
  const path = require('node:path');
  const open = fs.openSync;
  let blocked = false;
  fs.openSync = function(file, flags, ...args) {
    if (!blocked && flags === 'r' && path.basename(String(file)).startsWith('.directory-output-')) {
      blocked = true;
      const directory = process.env.SUBTOOL_DIRECTORY_RACE_GATE;
      fs.writeFileSync(path.join(directory, 'ready'), 'ready');
      const waiter = new Int32Array(new SharedArrayBuffer(4));
      while (!fs.existsSync(path.join(directory, 'release'))) Atomics.wait(waiter, 0, 0, 10);
    }
    return open.call(this, file, flags, ...args);
  };
}
