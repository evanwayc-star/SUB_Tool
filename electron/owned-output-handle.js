'use strict';

const { lstatSync } = require('node:fs');
const { open } = require('node:fs/promises');

const unsafe = () => Object.assign(new Error('匯出暫存成品開啟後身分已變更'), { code: 'UNSAFE_DELIVERY_STAGE' });
const sameFile = (left, right) => left.dev === right.dev && left.ino === right.ino;
const regular = stat => stat.isFile() && !stat.isSymbolicLink();
const closeFailure = (closeError, original) => {
  const prior = original ? `原始錯誤：${original.message}；` : '';
  return Object.assign(new Error(`${prior}關閉輸出 handle 失敗：${closeError.message}`, { cause: original || closeError }),
    { code: 'OUTPUT_HANDLE_CLOSE_FAILED' });
};

// 開檔會讓出執行權。以開檔前、handle 與開檔後的身分交叉比對，避免路徑
// 在等待期間被換掉又換回時，後續 truncate / write 作用於外來 handle。
async function openOwnedOutput(file, flags, assertOutput) {
  if (flags !== 'r' && flags !== 'r+') throw new TypeError('交付輸出只能以不截斷的模式開啟');
  assertOutput?.();
  const before = lstatSync(file, { bigint: true });
  if (!regular(before)) throw unsafe();
  assertOutput?.();
  const handle = await open(file, flags);
  try {
    const opened = await handle.stat({ bigint: true });
    assertOutput?.();
    const after = lstatSync(file, { bigint: true });
    if (!regular(opened) || !regular(after) || !sameFile(before, opened) || !sameFile(before, after)) throw unsafe();
    return handle;
  } catch (error) {
    try { await handle.close(); }
    catch (closeError) { throw closeFailure(closeError, error); }
    throw error;
  }
}

async function withOwnedOutput(file, flags, assertOutput, operation) {
  const handle = await openOwnedOutput(file, flags, assertOutput);
  let original;
  try { return await operation(handle); }
  catch (error) { original = error; throw error; }
  finally {
    try { await handle.close(); } catch (error) { throw closeFailure(error, original); }
  }
}

module.exports = { openOwnedOutput, withOwnedOutput };
