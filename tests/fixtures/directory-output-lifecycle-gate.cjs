'use strict';

const { isMainThread, workerData, parentPort } = require('node:worker_threads');
if (!isMainThread && workerData?.task === 'directory-output') {
  const fs = require('node:fs');
  const path = require('node:path');
  const label = Buffer.from(workerData.files[0].b64, 'base64').toString();
  if (label === 'failed') throw new Error('injected worker failure');
  const gate = process.env.SUBTOOL_DIRECTORY_LIFECYCLE_GATE;
  const post = parentPort.postMessage.bind(parentPort);
  parentPort.postMessage = message => {
    post(message);
    fs.writeFileSync(path.join(gate, `ready-${label}`), 'ready');
    const waiter = new Int32Array(new SharedArrayBuffer(4));
    while (!fs.existsSync(path.join(gate, `release-${label}`))) Atomics.wait(waiter, 0, 0, 10);
  };
}
