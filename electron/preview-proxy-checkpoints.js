'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { createClipCacheArtifact } = require('./clip-cache-artifact');
const { digestFile, sameSnapshot } = require('./file-content-evidence');
const { sourceClockSeek } = require('./media-source-clock');
const { PREVIEW_MP4_TIMECODE_ARGS } = require('./ffmpeg-execution-engine');

// Each part retains the original presentation timestamps. At assembly the
// offsets use the first *actual* frame of each part, including gaps in VFR.
async function encodeCheckpointedProxy({plan, request, video, sourceContent, seconds, execute, describe, verify, progress, prefix}) {
  const parts = [], staged = [];
  let resumed=0;
  const startAt = prefix?.end || 0;
  const count = Math.ceil((request.duration - startAt) / seconds);
  const map = plan.args.findIndex((arg, i) => arg === '-map' && plan.args[i + 1] === '0:v:0');
  const input = plan.args.indexOf('-i'), proxy = plan.args.indexOf(plan.meta.proxy);
  const mappings = plan.args.slice(map+2, plan.args.indexOf('-vf',map));
  const videoArgs = ['-map','0:v:0','-an',...plan.args.slice(plan.args.indexOf('-vf',map),plan.args.indexOf('-movflags',map))];
  const vf = videoArgs.indexOf('-vf') + 1;
  if (input < 0 || map < 0 || proxy < 0 || !vf || !videoArgs[vf].startsWith('setpts=PTS-STARTPTS,')) {
    throw new Error('無法識別 Proxy 分段的視訊配方');
  }
  const recipe = JSON.stringify([2, sourceContent, video, videoArgs, seconds]);
  const staging = path.dirname(plan.meta.proxy);
  async function locate(store, key, start, end) {
    for (const candidate of store.candidates()) {
      if (!candidate.ready) continue;
      try {
        verify(); candidate.verify();
        const marker = await fs.promises.open(candidate.ready, 'r');
        let row;
        try {
          const stat = await marker.stat({bigint:true}), entry = fs.lstatSync(candidate.ready,{bigint:true});
          if (!stat.isFile() || stat.dev!==entry.dev || stat.ino!==entry.ino || stat.size>4096n) continue;
          row = JSON.parse(await marker.readFile('utf8'));
        } finally { await marker.close(); }
        if (row.key !== key || !(row.first === null || (Number.isFinite(row.first) && row.first >= start-0.000001 && row.first < end))) continue;
        candidate.verify();
        const expected = fs.lstatSync(candidate.path,{bigint:true});
        const proof = await digestFile(fs.promises,candidate.path,expected);
        candidate.verify(); verify();
        if (row.sha256===proof.digest && row.size===Number(proof.size)) return { ...candidate, first:row.first, snapshot:expected };
      } catch (_) { verify(); }
    }
    return null;
  }
  async function encodePart(start, end, index) {
    const key = 'proxy-part-' + crypto.createHash('sha256').update(recipe).update(JSON.stringify([start,end])).digest('hex');
    verify();
    const store = createClipCacheArtifact(plan.dir,key,'mp4');
    const saved = await locate(store,key,start,end);
    if (saved) { resumed++;return saved; }
    verify();
    const artifact = store.reserve();
    try {
      const args = [...videoArgs], streamStart = video.streamStart ?? -(video.presentationTimestampOffset || 0);
      // Subtract the absolute stream origin in its own time base. Subtracting
      // a rounded container epoch first can put frame zero just below the trim.
      args[vf] = 'setpts=PTS-round('+Number(streamStart)+'/TB),settb=AVTB'+
        ',trim=start_pts='+Math.round(start*1e6)+':end_pts='+Math.round(end*1e6)+','+
        args[vf].slice('setpts=PTS-STARTPTS,'.length);
      const {seek} = sourceClockSeek(Math.max(0,start-1),video);
      await execute([...plan.args.slice(0,input),'-copyts','-ss',seek.toFixed(6),'-noaccurate_seek','-i',request.src,...args,
        '-fps_mode','passthrough','-enc_time_base','1:1000000','-video_track_timescale','1000000',
        '-movie_timescale','1000000','-avoid_negative_ts','disabled',...PREVIEW_MP4_TIMECODE_ARGS,'-f','mp4','fd:'],
      {outputDescriptor:artifact.fd,duration:request.duration,onProgress:()=>progress(index,count,resumed)});
      verify(); artifact.verify(); fs.fsyncSync(artifact.fd);
      const info = await describe(artifact.path);
      const first = info?.video ? -info.video.presentationTimestampOffset : null;
      if (first !== null && (!Number.isFinite(first) || first < start-0.000001 || first >= end))
        throw new Error('Proxy 分段的第一格時間超出範圍');
      const snapshot=fs.fstatSync(artifact.fd,{bigint:true});
      const proof = await digestFile(fs.promises,artifact.path,snapshot);
      verify(); artifact.verify();
      artifact.publish({key,first,size:Number(proof.size),sha256:proof.digest});
      return {path:artifact.path,first,verify:artifact.verify,snapshot};
    } finally { await artifact.close(); }
  }
  // Keep the concat manifest limited to filenames created by this writer.
  // A hard link pins the verified part even if its shared pathname changes.
  async function stagePart(part, name) {
    verify(); part.verify();
    const file = path.join(staging,name), inputFile = await fs.promises.open(part.path,'r');
    let entry;
    try {
      const source = await inputFile.stat({bigint:true});
      part.verify(source);
      if(!samePart(source,part.snapshot))throw new Error('分段內容在交接前變更');
      try {
        await fs.promises.link(part.path,file);
        const linked = fs.lstatSync(file,{bigint:true});
        if (!linked.isFile() || linked.dev!==source.dev || linked.ino!==source.ino || linked.mtimeNs!==source.mtimeNs ||
          linked.size!==source.size)throw new Error('分段檔案已變更');
        entry=linked;
      } catch(error) {
        if (!['EPERM','EACCES','ENOTSUP','ENOSYS','EXDEV'].includes(error.code)) throw error;
        verify(); part.verify(source);
        const copy = await fs.promises.open(file,'wx');
        try {
          entry = await copy.stat({bigint:true});
          await pipeline(inputFile.createReadStream({autoClose:false}),copy.createWriteStream({autoClose:true}));
        } finally { await copy.close(); }
        const written=fs.lstatSync(file,{bigint:true});
        if(written.dev!==entry.dev||written.ino!==entry.ino||written.size!==source.size||
          !sameSnapshot(source,await inputFile.stat({bigint:true})))throw new Error('分段內容在複製期間變更');
        entry=written;
      }
      part.verify(source); verify();
    } finally {
      if (entry) staged.push({file,entry});
      await inputFile.close();
    }
  }
  try {
    if (prefix) {
      // The live fMP4 also carries a MIX and its muxer may use a different
      // track timescale. Concat expects every input to have identical stream
      // order and time bases. Normalise the retained video by stream copy.
      const file=path.join(staging,'prefix.mp4');
      const fd=fs.openSync(file,'wx+');
      try{
        verify();prefix.verify();
        await execute(['-y','-i',prefix.path,'-map','0:v:0','-c:v','copy','-an',
          '-movie_timescale','1000000','-video_track_timescale','1000000',...PREVIEW_MP4_TIMECODE_ARGS,'-f','mp4','fd:'],
        {outputDescriptor:fd,label:'接回已完成的串流畫格',duration:prefix.end});
        verify();prefix.verify();
      }finally{staged.push({file,entry:fs.fstatSync(fd,{bigint:true})});fs.closeSync(fd);}
      parts.push({first:0,name:'prefix.mp4'});
    }
    for (let index=0;index<count;index++) {
      const start=startAt+index*seconds, end=Math.min(request.duration,startAt+(index+1)*seconds);
      let part=await encodePart(start,end,index);
      verify();
      if (part.first!==null) {
        const name='part-'+index+'.mp4';
        try { await stagePart(part,name); }
        catch(error) {
          // A second workstation can publish and retire a shared part in
          // between our lookup and pin. Only retry an as-yet unstaged file.
          if(!['ENOENT','CLIP_CACHE_CHANGED'].includes(error.code)||fs.existsSync(path.join(staging,name)))throw error;
          verify();
          part=await encodePart(start,end,index);
          await stagePart(part,name);
        }
        parts.push({first:part.first,name});
      }
      progress(index+1,count,resumed);
    }
    if (!parts.length) throw new Error('Proxy 分段未產生可播放的畫格');
    const lines = parts.map((part,i) => 'file '+part.name+
      (parts[i+1]?'\nduration '+(parts[i+1].first-part.first).toFixed(6):''));
    const manifest = path.join(staging,'parts.ffconcat');
    verify();
    const fd=fs.openSync(manifest,'wx');
    try { fs.writeFileSync(fd,lines.join('\n')+'\n');staged.push({file:manifest,entry:fs.fstatSync(fd,{bigint:true})}); }
    finally { fs.closeSync(fd); }
    const extra=plan.args.slice(proxy+1);
    const mux=['-f','concat','-safe','1','-i',manifest];
    const filters=plan.args.slice(input+2,map);
    const args=extra.length||plan.previewMix?['-y','-i',request.src,...mux,...filters,'-map','1:v:0']:['-y',...mux,'-map','0:v:0'];
    const verifyStaging=()=>{
      verify();
      for(const {file,entry} of staged)if(!samePart(entry,fs.lstatSync(file,{bigint:true})))throw new Error('合併中的分段已變更');
    };
    verifyStaging();
    await execute([...args,'-c:v','copy',...mappings,'-movie_timescale','1000000','-video_track_timescale','1000000',
      '-movflags','+faststart',...PREVIEW_MP4_TIMECODE_ARGS,plan.meta.proxy,...extra],{duration:request.duration,label:'合併已驗證的 Proxy 分段及準備聲道'});
    verifyStaging();
  } finally {
    for(const {file,entry} of staged){
      // A replacement directory or entry never becomes our cleanup target.
      try{
        plan.assertRetryOwner();
        const actual=fs.lstatSync(file,{bigint:true});
        if(actual.dev===entry.dev&&actual.ino===entry.ino)fs.unlinkSync(file);
      }catch(_){/* A private generation that cannot be verified stays intact. */}
    }
  }
}
// Creating or removing another verified hard link changes ctime without
// changing these bytes. The digest proof precedes pinning the file.
function samePart(left,right) {
  return left?.isFile() && right?.isFile() && ['dev','ino','size','mtimeNs','mode'].every(k=>left[k]===right[k]);
}
// A completed Proxy also supersedes intermediate data from an earlier
// hardware profile or an interrupted streaming/batch attempt for this source.
// Only closed, receipt-bearing entries in this verified source bucket retire.
async function retireProxyCheckpoints(plan, isCurrent = () => true) {
  try {
    if (!isCurrent()) return;
    plan.assertRetryOwner();
    const root = fs.lstatSync(plan.dir, { bigint: true });
    const names = await fs.promises.readdir(plan.dir);
    for (const name of names) {
      if (!/^proxy-(?:part|stream)-[0-9a-f]{64}$/.test(name)) continue;
      if (!isCurrent()) return;
      const namedRoot = fs.lstatSync(plan.dir, { bigint: true });
      if (!namedRoot.isDirectory() || namedRoot.ino !== root.ino || namedRoot.dev !== root.dev) return;
      const store = createClipCacheArtifact(plan.dir, name, 'mp4');
      for (const candidate of store.candidates()) {
        if (!candidate.ready) continue;
        try {
          candidate.verify();
          const file = await fs.promises.open(candidate.ready, 'r');
          let info, row;
          try {
            info = await file.stat({ bigint: true });
            candidate.verify();
            if (info.size <= 0n || info.size > 4096n ||
                !sameSnapshot(info, fs.lstatSync(candidate.ready, { bigint: true }))) continue;
            const bytes = Buffer.alloc(Number(info.size));
            let offset = 0;
            while (offset < bytes.length) {
              const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
              if (!bytesRead) break;
              offset += bytesRead;
            }
            if (offset !== bytes.length) continue;
            row = JSON.parse(bytes.toString('utf8'));
          } finally { await file.close(); }
          if (!isCurrent()) return;
          candidate.verify();
          if (row.key === name && sameSnapshot(info, fs.lstatSync(candidate.ready, { bigint: true }))) {
            candidate.retire();
          }
        } catch (_) { /* Other writers or cleanup may have retired it first. */ }
      }
    }
  } catch (_) { /* An uncertain directory stays intact. */ }
}
module.exports = { encodeCheckpointedProxy, retireProxyCheckpoints };
