/* ==============================================================================
   SUB Tool — Transcript-to-audio alignment
   ============================================================================== */
import OpenCC from 'opencc-js/cn2t';

const toTaiwanTraditional = OpenCC.Converter({ from: 'cn', to: 'twp' });
const TOKEN_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;

export function parseTranscriptLines(transcript) {
  return String(transcript ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
}

function normalizeToken(value) {
  return toTaiwanTraditional(String(value ?? '').normalize('NFKC'))
    .replace(/’/g, "'")
    .toLocaleLowerCase('en-US');
}

function tokenize(value) {
  return [...String(value ?? '').matchAll(TOKEN_PATTERN)].map(match => ({
    raw: match[0],
    normalized: normalizeToken(match[0])
  }));
}

function hasValidTime(start, end) {
  return Number.isFinite(start) && Number.isFinite(end) && end > start;
}

function evidenceTokensFromSegments(evidenceSegments) {
  const tokens = [];
  for (const segment of Array.isArray(evidenceSegments) ? evidenceSegments : []) {
    const segmentStart = Number(segment?.start);
    const segmentEnd = Number(segment?.end);
    const words = Array.isArray(segment?.words)
      ? segment.words.filter(word => hasValidTime(Number(word?.start), Number(word?.end)))
      : [];

    if (words.length) {
      for (const word of words) {
        for (const token of tokenize(word.text)) {
          tokens.push({
            ...token,
            start: Number(word.start),
            end: Number(word.end),
            timingEvidence: 'word'
          });
        }
      }
      continue;
    }

    if (!hasValidTime(segmentStart, segmentEnd)) continue;
    const segmentTokens = tokenize(segment?.text);
    const duration = segmentEnd - segmentStart;
    segmentTokens.forEach((token, index) => {
      tokens.push({
        ...token,
        start: segmentStart + (duration * index / segmentTokens.length),
        end: segmentStart + (duration * (index + 1) / segmentTokens.length),
        timingEvidence: 'segment'
      });
    });
  }
  return tokens;
}

const ALIGN_DIAGONAL = 1;
const ALIGN_TRANSCRIPT_GAP = 2;
const ALIGN_EVIDENCE_GAP = 3;
const MAX_ALIGNMENT_CELLS = 16_000_000;

function alignTokenSequences(transcriptTokens, evidenceTokens) {
  const transcriptLength = transcriptTokens.length;
  const evidenceLength = evidenceTokens.length;
  if (!transcriptLength || !evidenceLength) return [];

  const longest = Math.max(transcriptLength, evidenceLength);
  const requestedBand = Math.max(64, Math.ceil(longest * 0.08));
  const cellLimitedBand = Math.max(32, Math.floor(MAX_ALIGNMENT_CELLS / (2 * (transcriptLength + 1))));
  const band = Math.min(longest, requestedBand, cellLimitedBand);
  const rowStarts = new Int32Array(transcriptLength + 1);
  const directions = new Array(transcriptLength + 1);

  const rangeForRow = row => {
    const center = Math.round(row * evidenceLength / transcriptLength);
    return {
      start: Math.max(0, center - band),
      end: Math.min(evidenceLength, center + band)
    };
  };

  const firstRange = rangeForRow(0);
  rowStarts[0] = firstRange.start;
  let previousCosts = new Float64Array(firstRange.end - firstRange.start + 1);
  const firstDirections = new Uint8Array(previousCosts.length);
  for (let j = firstRange.start; j <= firstRange.end; j++) {
    previousCosts[j - firstRange.start] = j;
    if (j > 0) firstDirections[j - firstRange.start] = ALIGN_EVIDENCE_GAP;
  }
  directions[0] = firstDirections;
  let previousStart = firstRange.start;
  let previousEnd = firstRange.end;

  const previousCostAt = column => (
    column >= previousStart && column <= previousEnd
      ? previousCosts[column - previousStart]
      : Number.POSITIVE_INFINITY
  );

  for (let i = 1; i <= transcriptLength; i++) {
    const { start, end } = rangeForRow(i);
    rowStarts[i] = start;
    const currentCosts = new Float64Array(end - start + 1);
    currentCosts.fill(Number.POSITIVE_INFINITY);
    const currentDirections = new Uint8Array(currentCosts.length);

    for (let j = start; j <= end; j++) {
      const currentIndex = j - start;
      const exact = j > 0 && transcriptTokens[i - 1].normalized === evidenceTokens[j - 1].normalized;
      const diagonal = j > 0 ? previousCostAt(j - 1) + (exact ? 0 : 1) : Number.POSITIVE_INFINITY;
      const transcriptGap = previousCostAt(j) + 1;
      const evidenceGap = j > start ? currentCosts[currentIndex - 1] + 1 : Number.POSITIVE_INFINITY;

      let best = diagonal;
      let direction = ALIGN_DIAGONAL;
      if (transcriptGap < best || (!exact && transcriptGap === best)) {
        best = transcriptGap;
        direction = ALIGN_TRANSCRIPT_GAP;
      }
      if (evidenceGap < best) {
        best = evidenceGap;
        direction = ALIGN_EVIDENCE_GAP;
      }
      currentCosts[currentIndex] = best;
      currentDirections[currentIndex] = direction;
    }

    previousCosts = currentCosts;
    previousStart = start;
    previousEnd = end;
    directions[i] = currentDirections;
  }

  if (evidenceLength < previousStart || evidenceLength > previousEnd ||
      !Number.isFinite(previousCosts[evidenceLength - previousStart])) return [];

  const pairs = [];
  let i = transcriptLength;
  let j = evidenceLength;
  while (i > 0 || j > 0) {
    const row = directions[i];
    const index = j - rowStarts[i];
    const direction = index >= 0 && index < row.length ? row[index] : 0;
    if (direction === ALIGN_DIAGONAL && i > 0 && j > 0) {
      pairs.push({
        transcriptIndex: i - 1,
        evidenceIndex: j - 1,
        exact: transcriptTokens[i - 1].normalized === evidenceTokens[j - 1].normalized
      });
      i--;
      j--;
    } else if (direction === ALIGN_TRANSCRIPT_GAP && i > 0) {
      i--;
    } else if (direction === ALIGN_EVIDENCE_GAP && j > 0) {
      j--;
    } else {
      return [];
    }
  }
  return pairs.reverse();
}

export function alignTranscriptToEvidence({ transcript, evidenceSegments } = {}) {
  const lines = parseTranscriptLines(transcript);
  const evidenceTokens = evidenceTokensFromSegments(evidenceSegments);
  if (!lines.length || !evidenceTokens.length) {
    return {
      status: 'failed',
      segments: [],
      summary: {
        coverage: 0,
        timingEvidence: 'none',
        reviewCount: 0,
        unmatchedLines: lines.map((_, index) => index),
        ambiguousLines: []
      }
    };
  }

  const transcriptTokens = [];
  const lineTokenCounts = [];
  lines.forEach((text, lineIndex) => {
    const lineTokens = tokenize(text);
    lineTokenCounts.push(lineTokens.length);
    lineTokens.forEach(token => transcriptTokens.push({ ...token, lineIndex }));
  });
  const alignedPairs = alignTokenSequences(transcriptTokens, evidenceTokens);
  const pairsByLine = lines.map(() => []);
  for (const pair of alignedPairs) {
    const transcriptToken = transcriptTokens[pair.transcriptIndex];
    if (transcriptToken) pairsByLine[transcriptToken.lineIndex].push(pair);
  }

  const matchedTokenCount = alignedPairs.filter(pair => pair.exact).length;
  const transcriptTokenCount = transcriptTokens.length;
  const unmatchedLines = [];
  const segments = lines.map((text, lineIndex) => {
    const linePairs = pairsByLine[lineIndex];
    const lineTokenCount = lineTokenCounts[lineIndex];
    const exactCount = linePairs.filter(pair => pair.exact).length;
    const substitutionCount = linePairs.length - exactCount;
    const coverage = lineTokenCount ? exactCount / lineTokenCount : 0;
    const score = lineTokenCount ? (exactCount + (substitutionCount * 0.35)) / lineTokenCount : 0;
    const first = evidenceTokens[linePairs[0]?.evidenceIndex];
    const last = evidenceTokens[linePairs[linePairs.length - 1]?.evidenceIndex];
    const timed = score >= 0.45 && hasValidTime(first?.start, last?.end);
    if (!timed) unmatchedLines.push(lineIndex);
    const timingEvidence = linePairs.every(pair => (
      evidenceTokens[pair.evidenceIndex]?.timingEvidence === 'word'
    )) ? 'word' : 'segment';

    return {
      text,
      timed,
      ...(timed ? { start: first.start, end: last.end } : {}),
      alignment: {
        status: timed ? (timingEvidence === 'word' ? 'matched' : 'review') : 'unmatched',
        score,
        tokenCoverage: coverage,
        timingEvidence
      }
    };
  });

  const coverage = transcriptTokenCount ? matchedTokenCount / transcriptTokenCount : 0;
  const ambiguousLineSet = new Set();
  for (let index = 1; index < segments.length; index++) {
    const previous = segments[index - 1];
    const current = segments[index];
    if (previous.timed && current.timed && current.start < previous.end - 0.000001) {
      ambiguousLineSet.add(index - 1);
      ambiguousLineSet.add(index);
    }
  }
  const ambiguousLines = [...ambiguousLineSet];
  const reviewCount = segments.filter(segment => segment.alignment.status === 'review').length;
  const timingKinds = new Set(segments
    .filter(segment => segment.timed)
    .map(segment => segment.alignment.timingEvidence));
  const timingEvidence = timingKinds.size === 0
    ? 'none'
    : (timingKinds.size === 1 ? [...timingKinds][0] : 'mixed');
  return {
    status: unmatchedLines.length === 0 && ambiguousLines.length === 0 && coverage >= 0.55
      ? 'aligned'
      : 'failed',
    segments,
    summary: { coverage, timingEvidence, reviewCount, unmatchedLines, ambiguousLines }
  };
}
