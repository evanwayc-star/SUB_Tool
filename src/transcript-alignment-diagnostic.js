/* ==============================================================================
   SUB Tool — Safe transcript-alignment diagnostic contract
   ============================================================================== */
import { parseTranscriptLines } from './transcript-alignment.js';

const DIAGNOSTIC_SCHEMA = 'subtool-transcript-alignment-diagnostic-v1';
const DIAGNOSTIC_PROVIDERS = new Set(['builtin', 'groq', 'openai', 'azure', 'google']);
const DIAGNOSTIC_LANGUAGES = new Set(['auto', 'zh', 'en', 'ja', 'ko']);
const DIAGNOSTIC_LOCALES = new Set(['zh-TW', 'en-US', 'ja-JP', 'ko-KR']);
const ALIGNMENT_STATUSES = new Set(['matched', 'review', 'unmatched']);
const ALIGNMENT_RESULTS = new Set(['aligned', 'failed']);
const TIMING_EVIDENCE = new Set(['word', 'segment', 'mixed', 'none']);
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function knownValue(value, allowed, fallback) {
  return allowed.has(value) ? value : fallback;
}

function sanitizeGeneratedAt(value) {
  return typeof value === 'string' && ISO_TIMESTAMP_PATTERN.test(value) && Number.isFinite(Date.parse(value))
    ? value
    : 'unknown';
}

function sanitizeWord(word) {
  const sanitized = {
    text: typeof word?.text === 'string' ? word.text : '',
    start: finiteNumber(word?.start),
    end: finiteNumber(word?.end)
  };
  const confidence = finiteNumber(word?.confidence);
  if (confidence != null) sanitized.confidence = confidence;
  return sanitized;
}

function sanitizeEvidenceSegment(segment) {
  const sanitized = {
    start: finiteNumber(segment?.start),
    end: finiteNumber(segment?.end),
    text: typeof segment?.text === 'string' ? segment.text : '',
    words: (Array.isArray(segment?.words) ? segment.words : []).map(sanitizeWord)
  };
  if (!sanitized.words.length) delete sanitized.words;
  if (DIAGNOSTIC_LOCALES.has(segment?.locale)) sanitized.locale = segment.locale;
  const speaker = finiteNumber(segment?.speaker);
  if (speaker != null && Number.isInteger(speaker)) sanitized.speaker = speaker;
  const channel = finiteNumber(segment?.channel);
  if (channel != null && Number.isInteger(channel)) sanitized.channel = channel;
  const confidence = finiteNumber(segment?.confidence);
  if (confidence != null) sanitized.confidence = confidence;
  return sanitized;
}

function sanitizeAlignment(segment) {
  const source = segment?.alignment || {};
  return {
    status: knownValue(source.status, ALIGNMENT_STATUSES, 'unmatched'),
    score: finiteNumber(source.score) ?? 0,
    tokenCoverage: finiteNumber(source.tokenCoverage) ?? 0,
    timingEvidence: knownValue(source.timingEvidence, TIMING_EVIDENCE, 'none')
  };
}

function sanitizeAudioSelection(selection) {
  if (selection?.mode !== 'source-channels' || !Array.isArray(selection.channels)) {
    return { mode: 'all-source-channels' };
  }
  const seen = new Set();
  const channels = [];
  for (const channel of selection.channels) {
    const sourceStream = finiteNumber(channel?.sourceStream);
    const sourceChannel = finiteNumber(channel?.sourceChannel);
    if (!Number.isInteger(sourceStream) || sourceStream < 0 ||
        !Number.isInteger(sourceChannel) || sourceChannel < 0) continue;
    const key = `${sourceStream}:${sourceChannel}`;
    if (seen.has(key)) continue;
    seen.add(key);
    channels.push({ sourceStream, sourceChannel });
  }
  return channels.length
    ? { mode: 'source-channels', channels }
    : { mode: 'all-source-channels' };
}

export function buildTranscriptAlignmentDiagnostic({
  generatedAt = new Date().toISOString(),
  provider = 'unknown',
  language = 'auto',
  audioSelection = null,
  transcript = '',
  evidenceSegments = [],
  alignmentResult = null
} = {}) {
  const lines = parseTranscriptLines(transcript);
  const segments = Array.isArray(alignmentResult?.segments) ? alignmentResult.segments : [];
  const summary = alignmentResult?.summary || {};
  const unmatched = new Set(Array.isArray(summary.unmatchedLines) ? summary.unmatchedLines : []);
  const ambiguous = new Set(Array.isArray(summary.ambiguousLines) ? summary.ambiguousLines : []);
  const lowCoverage = new Set(Array.isArray(summary.lowCoverageLines) ? summary.lowCoverageLines : []);
  const unreliableIndexes = [...new Set([...unmatched, ...ambiguous, ...lowCoverage])]
    .filter(index => Number.isInteger(index) && index >= 0 && index < lines.length)
    .sort((a, b) => a - b);

  const unreliableLines = unreliableIndexes.map(index => {
    const segment = segments[index] || {};
    const item = {
      lineNumber: index + 1,
      text: lines[index],
      reasons: [
        ...(unmatched.has(index) ? ['unmatched'] : []),
        ...(ambiguous.has(index) ? ['ambiguous'] : []),
        ...(lowCoverage.has(index) ? ['low-coverage'] : [])
      ],
      timed: segment.timed === true
    };
    const start = finiteNumber(segment.start);
    const end = finiteNumber(segment.end);
    if (item.timed && start != null && end != null) {
      item.start = start;
      item.end = end;
    }
    item.alignment = sanitizeAlignment(segment);
    return item;
  });

  return {
    schema: DIAGNOSTIC_SCHEMA,
    generatedAt: sanitizeGeneratedAt(generatedAt),
    timeDomain: 'source-relative-seconds',
    provider: DIAGNOSTIC_PROVIDERS.has(provider) ? provider : 'unknown',
    language: DIAGNOSTIC_LANGUAGES.has(language) ? language : 'auto',
    audioSelection: sanitizeAudioSelection(audioSelection),
    transcriptLineCount: lines.length,
    transcriptLines: lines,
    alignmentStatus: knownValue(alignmentResult?.status, ALIGNMENT_RESULTS, 'failed'),
    summary: {
      coverage: finiteNumber(summary.coverage) ?? 0,
      timingEvidence: knownValue(summary.timingEvidence, TIMING_EVIDENCE, 'none'),
      reviewCount: Math.max(0, Math.floor(finiteNumber(summary.reviewCount) ?? 0)),
      unreliableLineCount: unreliableLines.length
    },
    unreliableLines,
    evidenceSegments: (Array.isArray(evidenceSegments) ? evidenceSegments : []).map(sanitizeEvidenceSegment)
  };
}
