/*
  The click boundary is the transaction boundary for a delivery submission.
  `capture` runs synchronously before conflict checks or any other await;
  everything after that point receives only the captured value.
*/
export async function runFrozenExportSubmission({
  capture,
  validate = () => null,
  checkConflicts = () => true,
  dispatch,
} = {}) {
  if (typeof capture !== 'function' || typeof dispatch !== 'function') {
    throw new TypeError('capture and dispatch are required');
  }

  const frozen = capture();
  if (!frozen) return { status: 'invalid', reason: '目前沒有可匯出的影片或外部音訊' };

  const invalidReason = validate(frozen);
  if (invalidReason) return { status: 'invalid', reason: invalidReason };
  if (!(await checkConflicts(frozen))) return { status: 'cancelled' };

  return { status: 'submitted', value: await dispatch(frozen) };
}
