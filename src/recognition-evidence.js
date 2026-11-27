const timingKinds = new Set(['word', 'segment', 'interpolated', 'mixed', 'none', 'frame']);
const providers = new Set(['builtin', 'openai', 'groq', 'azure', 'google', 'elevenlabs', 'gemini', 'openrouter']);

// Persist only the material needed to inspect a cue. File locations, request
// payloads and credentials can never enter a project through this record.
export function normalizeRecognitionEvidence(value) {
  if (!value || typeof value !== 'object' || !['speech','alignment','screen'].includes(value.kind)) return undefined;
  const result = { kind:value.kind };
  if (providers.has(value.provider)) result.provider = value.provider;
  if (typeof value.originalText === 'string') result.originalText = value.originalText.slice(0, 12000);
  if (typeof value.heardText === 'string' && value.heardText) result.heardText = value.heardText.slice(0, 12000);
  if (timingKinds.has(value.timingEvidence)) result.timingEvidence = value.timingEvidence;
  if(value.kind==='screen' && ['dialogue','card'].includes(value.screenKind))result.screenKind=value.screenKind;
  for (const key of ['sourceId','speaker','speakerScope','slot']) {
    if (typeof value[key] === 'string' || Number.isFinite(value[key])) {
      const text = String(value[key]).trim();
      if (text && text.length <= 160 && !/[\\/]/u.test(text)) result[key] = text;
    }
  }
  for (const key of ['sourceStart','sourceEnd']) {
    if (Number.isFinite(value[key]) && value[key] >= 0) result[key] = value[key];
  }
  if (Number.isInteger(value.transcriptLineIndex) && value.transcriptLineIndex >= 0) result.transcriptLineIndex = value.transcriptLineIndex;
  if (Array.isArray(value.words)) {
    const words = value.words.slice(0,512).flatMap(word => {
      const text = word?.word ?? word?.text;
      return typeof text === 'string' && Number.isFinite(word.start) && Number.isFinite(word.end) && word.end >= word.start
        ? [{ text:text.slice(0,200), start:word.start, end:word.end }] : [];
    });
    if (words.length) result.words = words;
  }
  return result;
}

// Preserve the provider's actual spellings alongside the line from the
// manuscript. This temporal join keeps overlapping speaker evidence intact.
export function attachAlignmentEvidence(lines, evidence) {
  const source = (evidence || []).filter(s => s.timed !== false && Number.isFinite(s.start) && s.end > s.start)
    .sort((a,b) => a.start-b.start);
  const ordered = lines.map((line,index) => ({line,index})).filter(({line}) => line.timed && line.end > line.start)
    .sort((a,b) => a.line.start-b.line.start);
  const result = lines.slice();
  let first = 0;
  for (const {line,index} of ordered) {
    while (first < source.length && source[first].end <= line.start) first++;
    const words=[], heard=[], speakers=new Map();
    for (let i=first; i<source.length && source[i].start<line.end; i++) {
      const segment=source[i];
      if(segment.end<=line.start)continue;
      const matches=(segment.words||[]).filter(w=>w.start < line.end && w.end > line.start);
      words.push(...matches);
      const actual=matches.length?matches.map(w=>w.text??w.word).join(' '):segment.originalText??segment.text;
      if(actual)heard.push(actual);
      if(segment.speaker!=null)speakers.set(JSON.stringify([segment.speakerScope,segment.speaker]),segment);
    }
    const speaker=speakers.size===1?speakers.values().next().value:null;
    result[index]={...line, ...(words.length && {words}), ...(heard.length && {heardText:heard.join(' ')}),
      ...(speaker && {speaker:speaker.speaker,speakerScope:speaker.speakerScope}), ...(speakers.size>1 && {needsReview:true})};
  }
  return result;
}
