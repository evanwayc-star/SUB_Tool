import { detectOverlaps } from './subtitle-model.js';
import { inspectSubtitleCharacters } from './subtitleTextCheck.js';

/**
 * @param {Array} cues - The list of cues to analyze.
 * @param {Object} options - Analysis options.
 * @param {number} [options.checkLenLimit=0] - Length limit for each line.
 * @param {string[]} [options.checkContains=[]] - Array of lowercase strings to check for.
 * @returns {Object} Structured diagnostic report.
 */
export function analyzeSubtitles(cues, options = {}) {
  const checkLenLimit = options.checkLenLimit || 0;
  const checkContains = options.checkContains || [];
  
  const overlapSet = detectOverlaps(cues);
  const result = {
    overlapNums: [], multiNums: [], twoNums: [], blankNums: [],
    bNums: [], iNums: [], uNums: [], fontNums: [], posNums: [],
    trimNums: [], overLenNums: [], containsNums: [], nonTraditionalIssues: [],
    noTimeNums: [], consecutiveIdenticalNums: []
  };

  const consecutiveIdenticalSet = new Set();
  
  for(let i=0; i<cues.length; i++){
    const c=cues[i];
    const num=i+1;
    const t=c.text||'';
    const trimmed=t.trim();
    const lower=t.toLowerCase();

    if(c.timed===false) result.noTimeNums.push(num);
    if(overlapSet.has(c.id)) result.overlapNums.push(num);

    if(!trimmed){
      result.blankNums.push(num);
    } else {
      const lineCnt=(t.match(/\n/g)||[]).length;
      if(lineCnt>=2) result.multiNums.push(num);
      else if(lineCnt===1) result.twoNums.push(num);
    }

    if(i>0){
      const prevTrimmed=(cues[i-1].text||'').trim();
      if(prevTrimmed && prevTrimmed===trimmed){
        consecutiveIdenticalSet.add(i);
        consecutiveIdenticalSet.add(num);
      }
    }

    if(/<\/?b>/i.test(t)) result.bNums.push(num);
    if(/<\/?i>/i.test(t)) result.iNums.push(num);
    if(/<\/?u>/i.test(t)) result.uNums.push(num);
    if(/<\/?font/i.test(t)) result.fontNums.push(num);
    if(/\{\\an\d\}/i.test(t)) result.posNums.push(num);

    if(/^[ 　]+|[ 　]+$/m.test(t)) result.trimNums.push(num);

    if(checkLenLimit && trimmed && t.split(/\n/).some(ln=>ln.length>checkLenLimit)){
      result.overLenNums.push(num);
    }

    if(checkContains.length && checkContains.some(kw=>lower.includes(kw.toLowerCase()))){
      result.containsNums.push(num);
    }

    const issue=inspectSubtitleCharacters(t);
    if(issue.simplified.length||issue.unsupported.length){
      result.nonTraditionalIssues.push({ num, ...issue });
    }
  }
  
  result.consecutiveIdenticalNums = Array.from(consecutiveIdenticalSet).sort((a,b)=>a-b);
  return result;
}
