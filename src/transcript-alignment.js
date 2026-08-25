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
const MIN_ALIGNMENT_COVERAGE = 0.55;
const MIN_SPARSE_RECOVERY_COVERAGE = 0.9;
const MAX_SPARSE_RECOVERY_RATIO = 0.05;
const MAX_SPARSE_RECOVERY_RUN = 3;
const MIN_ESTIMATED_SECONDS_PER_TOKEN = 0.18;
const MAX_ESTIMATED_SECONDS_PER_TOKEN = 0.8;
const MAX_LOW_CONFIDENCE_EXACT_GAP_SECONDS = 8;

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

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function consecutiveRuns(indexes) {
  const runs = [];
  for (const index of indexes) {
    const current = runs[runs.length - 1];
    if (current && index === current[current.length - 1] + 1) current.push(index);
    else runs.push([index]);
  }
  return runs;
}

function timingPairClusters(pairs, evidenceTokens) {
  const clusters = [];
  for (const pair of pairs) {
    const current = clusters[clusters.length - 1];
    const previousPair = current?.[current.length - 1];
    const previousToken = evidenceTokens[previousPair?.evidenceIndex];
    const token = evidenceTokens[pair.evidenceIndex];
    if (current && Number(token?.start) - Number(previousToken?.end) <= MAX_LOW_CONFIDENCE_EXACT_GAP_SECONDS) {
      current.push(pair);
    } else {
      clusters.push([pair]);
    }
  }
  return clusters;
}

function selectDensestLatestCluster(clusters) {
  return [...clusters].sort((a, b) => (
    b.length - a.length ||
    b[b.length - 1].evidenceIndex - a[a.length - 1].evidenceIndex
  ))[0] || [];
}

function selectTimingPairs(exactPairs, linePairs, evidenceTokens, score) {
  if (!exactPairs.length) return { pairs: linePairs, discontinuous: false, discardedPairs: [] };
  if (score >= 0.8) return { pairs: exactPairs, discontinuous: false, discardedPairs: [] };
  const clusters = timingPairClusters(exactPairs, evidenceTokens);
  if (clusters.length <= 1) return { pairs: exactPairs, discontinuous: false, discardedPairs: [] };
  const selected = selectDensestLatestCluster(clusters);
  return {
    pairs: selected,
    discontinuous: true,
    discardedPairs: clusters.filter(cluster => cluster !== selected).flat()
  };
}

function monotonicExactPairsForLine(lineTokens, evidencePairs, evidenceTokens) {
  const matchedPairs = [];
  let evidenceCursor = 0;
  for (const token of lineTokens) {
    let matchIndex = -1;
    for (let index = evidenceCursor; index < evidencePairs.length; index++) {
      if (evidenceTokens[evidencePairs[index].evidenceIndex]?.normalized === token.normalized) {
        matchIndex = index;
        break;
      }
    }
    if (matchIndex < 0) continue;
    matchedPairs.push(evidencePairs[matchIndex]);
    evidenceCursor = matchIndex + 1;
  }
  return matchedPairs;
}

function reassignDiscardedExactEvidence({
  segments,
  lineTokensByLine,
  evidenceTokens,
  discardedExactPairsByLine,
  partialEvidenceByLine
}) {
  for (let ownerIndex = 0; ownerIndex < discardedExactPairsByLine.length; ownerIndex++) {
    const discardedClusters = timingPairClusters(
      discardedExactPairsByLine[ownerIndex].filter(pair => (
        evidenceTokens[pair.evidenceIndex]?.timingEvidence === 'word'
      )),
      evidenceTokens
    );
    if (!discardedClusters.length) continue;
    const precedingUnmatched = [];
    for (let index = ownerIndex - 1; index >= 0 && !segments[index]?.timed; index--) {
      precedingUnmatched.unshift(index);
    }
    if (!precedingUnmatched.length) continue;

    let best = null;
    for (const lineIndex of precedingUnmatched) {
      for (const cluster of discardedClusters) {
        const monotonicPairs = monotonicExactPairsForLine(
          lineTokensByLine[lineIndex],
          cluster,
          evidenceTokens
        );
        for (const matchedPairs of timingPairClusters(monotonicPairs, evidenceTokens)) {
          const coverage = matchedPairs.length / Math.max(1, lineTokensByLine[lineIndex].length);
          if (coverage < 0.3) continue;
          const lastEvidenceIndex = matchedPairs[matchedPairs.length - 1].evidenceIndex;
          if (!best || coverage > best.coverage ||
              (coverage === best.coverage && lineIndex > best.lineIndex) ||
              (coverage === best.coverage && lineIndex === best.lineIndex &&
               lastEvidenceIndex > best.lastEvidenceIndex)) {
            best = { lineIndex, matchedPairs, coverage, lastEvidenceIndex };
          }
        }
      }
    }
    if (!best || partialEvidenceByLine[best.lineIndex]) continue;
    const orderedPairs = [...best.matchedPairs].sort((a, b) => a.evidenceIndex - b.evidenceIndex);
    const first = evidenceTokens[orderedPairs[0].evidenceIndex];
    const last = evidenceTokens[orderedPairs[orderedPairs.length - 1].evidenceIndex];
    if (hasValidTime(first?.start, last?.end)) {
      partialEvidenceByLine[best.lineIndex] = { start: first.start, end: last.end };
    }
  }
}

function recoverSparseUnmatchedSegments({
  segments,
  lineTokenCounts,
  partialEvidenceByLine,
  coverage,
  unmatchedLines,
  ambiguousLines
}) {
  const maximumRecoverable = Math.floor(segments.length * MAX_SPARSE_RECOVERY_RATIO);
  const runs = consecutiveRuns(unmatchedLines);
  if (coverage < MIN_SPARSE_RECOVERY_COVERAGE || ambiguousLines.length ||
      unmatchedLines.length > maximumRecoverable ||
      runs.some(run => run.length > MAX_SPARSE_RECOVERY_RUN)) {
    return { segments, unmatchedLines, estimatedLines: [], partialEvidenceLines: [] };
  }

  const secondsPerToken = median(segments.flatMap((segment, index) => {
    const tokenCount = lineTokenCounts[index];
    return segment.timed && tokenCount > 0 && hasValidTime(segment.start, segment.end)
      ? [(segment.end - segment.start) / tokenCount]
      : [];
  }));
  if (!Number.isFinite(secondsPerToken)) {
    return { segments, unmatchedLines, estimatedLines: [], partialEvidenceLines: [] };
  }
  const boundedSecondsPerToken = Math.max(
    MIN_ESTIMATED_SECONDS_PER_TOKEN,
    Math.min(MAX_ESTIMATED_SECONDS_PER_TOKEN, secondsPerToken)
  );
  const recovered = segments.map(segment => ({
    ...segment,
    alignment: { ...segment.alignment }
  }));
  const estimatedLines = [];
  const partialEvidenceLines = [];

  for (const index of unmatchedLines) {
    const candidate = partialEvidenceByLine[index];
    if (!candidate || !hasValidTime(candidate.start, candidate.end)) continue;
    let previousIndex = index - 1;
    while (previousIndex >= 0 && !recovered[previousIndex]?.timed) previousIndex--;
    let nextIndex = index + 1;
    while (nextIndex < recovered.length && !recovered[nextIndex]?.timed) nextIndex++;
    const previous = recovered[previousIndex];
    const next = recovered[nextIndex];
    if (!previous?.timed || !next?.timed || candidate.start < previous.end || candidate.end > next.start) continue;
    recovered[index] = {
      ...recovered[index],
      timed: true,
      start: candidate.start,
      end: candidate.end,
      alignment: {
        ...recovered[index].alignment,
        status: 'review',
        timingEvidence: 'word'
      }
    };
    partialEvidenceLines.push(index);
  }

  const remainingUnmatched = unmatchedLines.filter(index => !recovered[index].timed);
  const remainingRuns = consecutiveRuns(remainingUnmatched);

  for (const run of remainingRuns) {
    const firstIndex = run[0];
    const lastIndex = run[run.length - 1];
    const previous = recovered[firstIndex - 1];
    const next = recovered[lastIndex + 1];
    if (!previous?.timed || !next?.timed || !hasValidTime(previous.start, previous.end) ||
        !hasValidTime(next.start, next.end) || next.start <= previous.end) {
      return { segments, unmatchedLines, estimatedLines: [], partialEvidenceLines: [] };
    }

    const gapStart = previous.end;
    const gapEnd = next.start;
    const weights = run.map(index => Math.max(1, lineTokenCounts[index] || 0));
    const totalWeight = weights.reduce((sum, value) => sum + value, 0);
    let usedWeight = 0;
    for (let offset = 0; offset < run.length; offset++) {
      const index = run[offset];
      const weight = weights[offset];
      const cellStart = gapStart + ((gapEnd - gapStart) * usedWeight / totalWeight);
      usedWeight += weight;
      const cellEnd = gapStart + ((gapEnd - gapStart) * usedWeight / totalWeight);
      const duration = Math.min(cellEnd - cellStart, weight * boundedSecondsPerToken);
      if (!(duration > 0)) return { segments, unmatchedLines, estimatedLines: [], partialEvidenceLines: [] };
      const start = cellStart + ((cellEnd - cellStart - duration) / 2);
      recovered[index] = {
        ...recovered[index],
        timed: true,
        start,
        end: start + duration,
        alignment: {
          ...recovered[index].alignment,
          status: 'review',
          timingEvidence: 'interpolated'
        }
      };
      estimatedLines.push(index);
    }
  }

  return { segments: recovered, unmatchedLines: [], estimatedLines, partialEvidenceLines };
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
        ambiguousLines: [],
        lowCoverageLines: []
      }
    };
  }

  const transcriptTokens = [];
  const lineTokenCounts = [];
  const lineTokensByLine = [];
  lines.forEach((text, lineIndex) => {
    const lineTokens = tokenize(text);
    lineTokensByLine.push(lineTokens);
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
  const partialEvidenceByLine = lines.map(() => null);
  const discontinuousEvidenceLines = [];
  const discardedExactPairsByLine = lines.map(() => []);
  const segments = lines.map((text, lineIndex) => {
    const linePairs = pairsByLine[lineIndex];
    const lineTokenCount = lineTokenCounts[lineIndex];
    const exactPairs = linePairs.filter(pair => pair.exact);
    const exactCount = exactPairs.length;
    const substitutionCount = linePairs.length - exactCount;
    const coverage = lineTokenCount ? exactCount / lineTokenCount : 0;
    const score = lineTokenCount ? (exactCount + (substitutionCount * 0.35)) / lineTokenCount : 0;
    const timingSelection = selectTimingPairs(exactPairs, linePairs, evidenceTokens, score);
    const timingPairs = timingSelection.pairs;
    if (timingSelection.discontinuous) {
      discontinuousEvidenceLines.push(lineIndex);
      discardedExactPairsByLine[lineIndex] = timingSelection.discardedPairs;
    }
    const first = evidenceTokens[timingPairs[0]?.evidenceIndex];
    const last = evidenceTokens[timingPairs[timingPairs.length - 1]?.evidenceIndex];
    const partialExactPairs = timingPairs.filter(pair => (
      pair.exact && evidenceTokens[pair.evidenceIndex]?.timingEvidence === 'word'
    ));
    const selectedPartialExactPairs = selectDensestLatestCluster(
      timingPairClusters(partialExactPairs, evidenceTokens)
    );
    const partialCoverage = lineTokenCount ? selectedPartialExactPairs.length / lineTokenCount : 0;
    const firstPartialExact = evidenceTokens[selectedPartialExactPairs[0]?.evidenceIndex];
    const lastPartialExact = evidenceTokens[
      selectedPartialExactPairs[selectedPartialExactPairs.length - 1]?.evidenceIndex
    ];
    if (selectedPartialExactPairs.length >= 2 && partialCoverage >= 0.3 &&
        hasValidTime(firstPartialExact?.start, lastPartialExact?.end)) {
      partialEvidenceByLine[lineIndex] = { start: firstPartialExact.start, end: lastPartialExact.end };
    }
    const timed = score >= 0.45 && hasValidTime(first?.start, last?.end);
    if (!timed) unmatchedLines.push(lineIndex);
    const timingEvidence = timingPairs.every(pair => (
      evidenceTokens[pair.evidenceIndex]?.timingEvidence === 'word'
    )) ? 'word' : 'segment';

    return {
      text,
      timed,
      ...(timed ? { start: first.start, end: last.end } : {}),
      alignment: {
        status: timed
          ? (timingEvidence === 'word' && !timingSelection.discontinuous ? 'matched' : 'review')
          : 'unmatched',
        score,
        tokenCoverage: coverage,
        timingEvidence
      }
    };
  });

  reassignDiscardedExactEvidence({
    segments,
    lineTokensByLine,
    evidenceTokens,
    discardedExactPairsByLine,
    partialEvidenceByLine
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
  const recovered = recoverSparseUnmatchedSegments({
    segments,
    lineTokenCounts,
    partialEvidenceByLine,
    coverage,
    unmatchedLines,
    ambiguousLines
  });
  const finalSegments = recovered.segments;
  const finalUnmatchedLines = recovered.unmatchedLines;
  const estimatedLines = recovered.estimatedLines;
  const partialEvidenceLines = recovered.partialEvidenceLines;
  const reviewCount = finalSegments.filter(segment => segment.alignment.status === 'review').length;
  const timingKinds = new Set(finalSegments
    .filter(segment => segment.timed)
    .map(segment => segment.alignment.timingEvidence));
  const timingEvidence = timingKinds.size === 0
    ? 'none'
    : (timingKinds.size === 1 ? [...timingKinds][0] : 'mixed');
  const lowCoverageLines = coverage < MIN_ALIGNMENT_COVERAGE
    ? segments.flatMap((segment, index) => (
      segment.alignment.tokenCoverage < MIN_ALIGNMENT_COVERAGE ? [index] : []
    ))
    : [];
  return {
    status: finalUnmatchedLines.length === 0 && ambiguousLines.length === 0 && coverage >= MIN_ALIGNMENT_COVERAGE
      ? (estimatedLines.length || partialEvidenceLines.length || discontinuousEvidenceLines.length
          ? 'recovered'
          : 'aligned')
      : 'failed',
    segments: finalSegments,
    summary: {
      coverage,
      timingEvidence,
      reviewCount,
      unmatchedLines: finalUnmatchedLines,
      ambiguousLines,
      lowCoverageLines,
      estimatedLines,
      partialEvidenceLines,
      discontinuousEvidenceLines
    }
  };
}
