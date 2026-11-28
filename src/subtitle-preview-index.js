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

function buildIndex(cues, exactFps){
  const records=[];
  for(let index=0;index<cues.length;index++){
    const cue=cues[index];
    if(cue.timed===false) continue;
    const start=Math.round(cue.start*exactFps), end=Math.round(cue.end*exactFps);
    if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start) continue;
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

function overlapping(records, value){
  const found=[];
  for(let i=upperBound(records,value)-1;i>=0;i--){
    if(records[i].maxEnd<=value) break;
    const record=records[i];
    if(record.end>value) found.push(record);
  }
  found.sort((a,b)=>a.index-b.index);
  return found;
}

export class SubtitlePreviewIndex {
  constructor(){ this.invalidate(); }

  invalidate(){ this._cues=null; this._frames=null; }

  _ensure(cues, exactFps){
    if(this._cues===cues&&this._length===cues.length&&this._fps===exactFps) return;
    this._cues=cues;
    this._length=cues.length;
    this._fps=exactFps;
    this._frames=buildIndex(cues,exactFps);
  }

  visibleAtFrame(cues,exactFps,frame){
    this._ensure(cues,exactFps);
    return overlapping(this._frames,frame).map(record=>record.cue);
  }

  activeAtTime(cues,exactFps,time,preferredIndex=-1,track=null){
    this._ensure(cues,exactFps);
    const matchesTrack = cue => track == null || (cue.track || 0) === track;
    const preferred=cues[preferredIndex];
    // FPS-SYNC: follow the same [start frame, end frame) as the preview and timecode.
    const frame=Math.round(time*exactFps);
    if(preferred&&matchesTrack(preferred)&&preferred.timed!==false
      &&frame>=Math.round(preferred.start*exactFps)&&frame<Math.round(preferred.end*exactFps))
      return {cue:preferred,index:preferredIndex};
    const first=overlapping(this._frames,frame).find(record=>matchesTrack(record.cue));
    return first ? {cue:first.cue,index:first.index} : null;
  }
}

export const subtitlePreviewIndex=new SubtitlePreviewIndex();
