/* Visible subtitles are queried on every presented frame. Keep the interval
   search here so the renderer and the active-row follower share one snapshot.
   Editing paths invalidate the snapshot before their next direct render. */
function upperBound(records, value){
  let lo=0, hi=records.length;
  while(lo<hi){
    const mid=(lo+hi)>>1;
    if(records[mid].start<=value) lo=mid+1;
    else hi=mid;
  }
  return lo;
}

function buildIndex(cues, startOf, endOf){
  const records=[];
  for(let index=0;index<cues.length;index++){
    const cue=cues[index];
    if(cue.timed===false) continue;
    const start=startOf(cue), end=endOf(cue);
    if(!Number.isFinite(start)||!Number.isFinite(end)||end<start) continue;
    records.push({cue,index,start,end});
  }
  records.sort((a,b)=>a.start-b.start||a.index-b.index);
  let maximum=-Infinity;
  for(const record of records){
    maximum=Math.max(maximum,record.end);
    record.maxEnd=maximum;
  }
  return records;
}

function overlapping(records, value, inclusiveEnd){
  const found=[];
  for(let i=upperBound(records,value)-1;i>=0;i--){
    if(inclusiveEnd ? records[i].maxEnd<value : records[i].maxEnd<=value) break;
    const record=records[i];
    if(inclusiveEnd ? record.end>=value : record.end>value) found.push(record);
  }
  found.sort((a,b)=>a.index-b.index);
  return found;
}

export class SubtitlePreviewIndex {
  constructor(){ this.invalidate(); }

  invalidate(){ this._cues=null; this._frames=null; this._times=null; }

  _ensure(cues, exactFps){
    if(this._cues===cues&&this._length===cues.length&&this._fps===exactFps) return;
    this._cues=cues;
    this._length=cues.length;
    this._fps=exactFps;
    this._frames=buildIndex(cues,c=>Math.round(c.start*exactFps),c=>Math.round(c.end*exactFps));
    this._times=buildIndex(cues,c=>c.start,c=>c.end);
  }

  visibleAtFrame(cues,exactFps,frame){
    this._ensure(cues,exactFps);
    return overlapping(this._frames,frame,false).map(record=>record.cue);
  }

  activeAtTime(cues,exactFps,time,preferredIndex=-1){
    this._ensure(cues,exactFps);
    const preferred=cues[preferredIndex];
    if(preferred&&preferred.timed!==false&&time>=preferred.start&&time<=preferred.end)
      return {cue:preferred,index:preferredIndex};
    const first=overlapping(this._times,time,true)[0];
    return first ? {cue:first.cue,index:first.index} : null;
  }
}

export const subtitlePreviewIndex=new SubtitlePreviewIndex();
