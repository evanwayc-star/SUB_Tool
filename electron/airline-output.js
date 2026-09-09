'use strict';

const fs = require('fs');
const path = require('path');
const { deliveryOutputNames } = require('../shared/delivery-formats.cjs');

// Supplied Panasonic_MIN_Mix_M2TS.cfg. File selection stays in Manzanita;
// changing its unspecified mux defaults would change the delivery contract.
const MANZANITA_CONFIG = [
  '# Manzanita Systems MP2TSME V8.0.0 Configuration File',
  '# Creation Date: 週一 八月 18 17:17:15 2025, by TSME3226',
  '', 'Transport*', '', 'Program1*', 'ProgramNumber = 0x1',
  'PMTPID = 0x3f', 'PCRPID = 0x30', 'TransportPriority = yes',
  '', 'Video1$', 'Rate = -1.000', 'PID = 0x30', 'TransportPriority = yes',
  '', 'Audio1$', 'PID = 0x31', 'TransportPriority = yes', '',
].join('\r\n');

function deliveryOutputPaths(format, outPath) {
  const dir = path.dirname(outPath);
  return deliveryOutputNames(format, path.basename(outPath)).map(name => path.join(dir, name));
}

async function finalizeAirlineOutput(format, outPath, { signal } = {}) {
  const outputPaths = deliveryOutputPaths(format, outPath);
  if (outputPaths.length !== 3) return null;
  signal?.throwIfAborted();
  for (const mediaPath of outputPaths.slice(0, 2)) {
    const stat = await fs.promises.stat(mediaPath);
    if (!stat.isFile() || stat.size === 0) {
      const error = new Error(`航空影音分流檔缺失或空白：${mediaPath}`);
      error.code = 'AIRLINE_OUTPUT_MISSING';
      throw error;
    }
  }
  signal?.throwIfAborted();
  await fs.promises.writeFile(outputPaths[2], MANZANITA_CONFIG, { encoding: 'utf8', signal });
  signal?.throwIfAborted();
  return { outputPaths, requiresManzanita: true };
}

module.exports = { deliveryOutputPaths, finalizeAirlineOutput, MANZANITA_CONFIG };
