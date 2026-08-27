/* 辨識結果與固定逐行文字稿的純對齊決策；不碰 Modal、State 或字幕寫入。 */
export function resolveRecognitionAlignment({ taskMode, transcript, evidenceSegments, alignTranscriptToEvidence }) {
  if (taskMode !== 'align') return { segments: evidenceSegments, alignment: null };
  const alignment = alignTranscriptToEvidence({ transcript, evidenceSegments });
  return { segments: alignment.completeSegments || alignment.segments, alignment };
}
