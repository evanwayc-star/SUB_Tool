'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createClipCacheArtifact } = require('./clip-cache-artifact');
const { sameSnapshot } = require('./file-content-evidence');

// The growing Proxy has closed GOPs, no B frames, and default-base-is-moof.
// Keep complete moof/mdat pairs only. The first video decode timestamp of
// the *following* fragment is the first frame that must be encoded again.
function childBoxes(bytes,start,end) {
  const boxes=[];
  while(start+8<=end) {
    const size=bytes.readUInt32BE(start);
    if(size<8||start+size>end)return [];
    boxes.push({type:bytes.toString('ascii',start+4,start+8),start:start+8,end:start+size});
    start+=size;
  }
  return start===end?boxes:[];
}

async function scanPrefix(handle,size,state) {
  let page=Buffer.alloc(0),base=-1;
  async function read(at,length) {
    if(at<base||at+length>base+page.length) {
      base=at;
      page=Buffer.allocUnsafe(Math.min(size-at,Math.max(length,256*1024)));
      let n=0;
      while(n<page.length){
        const {bytesRead}=await handle.read(page,n,page.length-n,at+n);
        if(!bytesRead)break;
        n+=bytesRead;
      }
      page=page.subarray(0,n);
    }
    return page.subarray(at-base,at-base+length);
  }
  let {track=0,scale=0,last=null,paired=false,at=0}=state;
  for(;at+8<=size;) {
    const header=await read(at,8);
    if(header.length<8)break;
    const n=header.readUInt32BE(0),type=header.toString('ascii',4);
    if(n<8||at+n>size)break;
    if(type==='moov'||type==='moof') {
      if(n>4*1024*1024)break;
      const b=await read(at,n);
      if(b.length!==n)break;
      const children=box=>childBoxes(b,box.start,box.end);
      const boxes=childBoxes(b,8,n);
      if(type==='moov') {
        for(const trak of boxes.filter(x=>x.type==='trak')) {
          const kids=children(trak),tkhd=kids.find(x=>x.type==='tkhd'),mdia=kids.find(x=>x.type==='mdia');
          if(!tkhd||!mdia)continue;
          const media=children(mdia),hdlr=media.find(x=>x.type==='hdlr'),mdhd=media.find(x=>x.type==='mdhd');
          if(!hdlr||!mdhd||b.toString('ascii',hdlr.start+8,hdlr.start+12)!=='vide')continue;
          track=b.readUInt32BE(tkhd.start+(b[tkhd.start]?20:12));
          scale=b.readUInt32BE(mdhd.start+(b[mdhd.start]?20:12));
        }
      }else if(track&&scale){
        for(const traf of boxes.filter(x=>x.type==='traf')){
          const kids=children(traf),tfhd=kids.find(x=>x.type==='tfhd'),tfdt=kids.find(x=>x.type==='tfdt');
          if(!tfhd||!tfdt||b.readUInt32BE(tfhd.start+4)!==track)continue;
          const ticks=b[tfdt.start]?Number(b.readBigUInt64BE(tfdt.start+4)):b.readUInt32BE(tfdt.start+4);
          if(paired&&Number.isSafeInteger(ticks)&&ticks>0)last={bytes:at,end:ticks/scale};
          paired=false;
        }
      }
    }else if(type==='mdat')paired=true;
    at+=n;
  }
  Object.assign(state,{track,scale,last,paired,at});
  return last;
}

async function readRange(input,start,end,destination,digest) {
  const buffer=Buffer.allocUnsafe(1024*1024);
  for(let at=start;at<end;){
    const {bytesRead}=await input.read(buffer,0,Math.min(buffer.length,end-at),at);
    if(!bytesRead)throw new Error('串流前段讀取不完整');
    if(destination!==undefined) {
      let written=0;
      while(written<bytesRead) {
        const count=await new Promise((resolve,reject)=>fs.write(destination,buffer,written,bytesRead-written,at+written,
          (error,n)=>error?reject(error):resolve(n)));
        if(!count)throw new Error('串流前段寫入不完整');
        written+=count;
      }
    }
    digest.update(buffer.subarray(0,bytesRead));
    at+=bytesRead;
  }
}

function streamPrefixStore(plan,sourceContent,video,audio,duration) {
  const key='proxy-stream-'+crypto.createHash('sha256').update(JSON.stringify([
    1,sourceContent,video,audio,duration,plan.args.slice(plan.args.indexOf('-vf'),plan.args.indexOf('-movflags')),
  ])).digest('hex');
  const store=createClipCacheArtifact(plan.dir,key,'mp4');
  async function recover() {
    let best=null;
    for(const candidate of store.candidates()) {
      if(!candidate.ready)continue;
      try{
        candidate.verify();
        const marker=await fs.promises.open(candidate.ready,'r');
        let row;
        try{
          const stat=await marker.stat({bigint:true}),named=fs.lstatSync(candidate.ready,{bigint:true});
          if(stat.ino!==named.ino||stat.dev!==named.dev||stat.size>4096n)continue;
          row=JSON.parse(await marker.readFile('utf8'));
        }finally{await marker.close();}
        if(row.key!==key||!(row.end>0&&row.end<duration)||row.end<=(best?.end||0))continue;
        const snapshot=fs.lstatSync(candidate.path,{bigint:true});
        if(!Number.isSafeInteger(row.bytes)||row.bytes<=0||Number(snapshot.size)<row.bytes)continue;
        const digest=crypto.createHash('sha256'),file=await fs.promises.open(candidate.path,'r');
        try {
          if(!sameSnapshot(snapshot,await file.stat({bigint:true})))continue;
          await readRange(file,0,row.bytes,undefined,digest);
          if(!sameSnapshot(snapshot,await file.stat({bigint:true})))continue;
        }finally{await file.close();}
        candidate.verify();plan.assertRetryOwner();
        if(digest.digest('hex')===row.hash)best={...candidate,end:row.end,bytes:row.bytes,
          hash:row.hash,sealed:row.sealed===true,snapshot};
      }catch(_){plan.assertRetryOwner();}
    }
    return best;
  }
  // Copy only newly sealed fragments. A crash while appending leaves the
  // previous receipt readable, even when later bytes are already on disk.
  function writer(file,verify,interval) {
    let entry,bytes=0,next=Math.min(5,interval),pending=Promise.resolve(),finished=false;
    const cursor={},digest=crypto.createHash('sha256');
    async function checkpoint() {
      plan.assertRetryOwner();verify();
      const input=await fs.promises.open(file,'r');
      try {
        const before=await input.stat({bigint:true});verify(before);
        const span=await scanPrefix(input,Number(before.size),cursor);
        if(!span||span.bytes<=bytes||!(span.end>0&&span.end<duration))return;
        plan.assertRetryOwner();verify(before);
        entry ||= store.reserve();
        await readRange(input,bytes,span.bytes,entry.fd,digest);
        entry.verify();verify(await input.stat({bigint:true}));plan.assertRetryOwner();
        fs.fsyncSync(entry.fd);
        entry.publish({key,...span,hash:digest.copy().digest('hex'),sealed:finished});
        bytes=span.bytes;
      }finally{await input.close();}
    }
    let busy=false,failed=false;
    function enqueue(){
      busy=true;
      pending=checkpoint().catch(()=>{failed=true;}).finally(()=>{busy=false;});
    }
    return {
      progress(percent) {
        const time=duration*percent/100;
        if(finished||failed||busy||!(time>=next))return;
        next=time+interval;
        enqueue();
      },
      async finish(interrupted) {
        if(finished)return;
        finished=true;
        await pending;
        try{if(interrupted&&!failed)await checkpoint();}
        finally{if(entry)await entry.close();}
      },
    };
  }
  async function pin(prefix) {
    plan.assertRetryOwner();prefix.verify();
    const file=path.join(path.dirname(plan.meta.proxy),'resume.mp4');
    let linked=false;
    if(prefix.sealed&&prefix.snapshot.size===BigInt(prefix.bytes)){
      if(!sameSnapshot(prefix.snapshot,fs.lstatSync(prefix.path,{bigint:true})))throw new Error('已驗證的串流前段在重開前變更');
      try{await fs.promises.link(prefix.path,file);linked=true;}
      catch(error){if(!['EACCES','EPERM','EXDEV','ENOTSUP','ENOSYS'].includes(error.code))throw error;}
    }
    if(!linked){
      const input=await fs.promises.open(prefix.path,'r');
      let output;
      try{
        prefix.verify(await input.stat({bigint:true}));
        output=await fs.promises.open(file,'wx');
        const digest=crypto.createHash('sha256');
        await readRange(input,0,prefix.bytes,output.fd,digest);
        if(digest.digest('hex')!==prefix.hash)throw new Error('串流前段在複製期間變更');
      }finally{await input.close();if(output)await output.close();}
    }
    plan.assertRetryOwner();prefix.verify();
    const snapshot=fs.lstatSync(file,{bigint:true});
    if(snapshot.size!==BigInt(prefix.bytes))throw new Error('串流前段複製不完整');
    if(linked&&(snapshot.ino!==prefix.snapshot.ino||snapshot.dev!==prefix.snapshot.dev||snapshot.mtimeNs!==prefix.snapshot.mtimeNs))
      throw new Error('串流前段連結在交接前變更');
    const verify=observed=>{
      const actual=fs.lstatSync(file,{bigint:true});
      if(!actual.isFile()||actual.dev!==snapshot.dev||actual.ino!==snapshot.ino||actual.size!==snapshot.size||
        actual.mtimeNs!==snapshot.mtimeNs||(observed&&(actual.dev!==observed.dev||actual.ino!==observed.ino)))throw new Error('播放中的串流前段已變更');
    };
    verify();
    return {path:file,verify,snapshot,end:prefix.end,remove(){try{plan.assertRetryOwner();verify();fs.unlinkSync(file);}catch(_){}}};
  }
  return {recover,writer,pin};
}
module.exports={streamPrefixStore};
