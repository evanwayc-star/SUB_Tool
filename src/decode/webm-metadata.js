/* Bounded WebM/Matroska header adapter. No decoder or media payload is retained.
   Element/timestamp rules: https://www.matroska.org/technical/elements.html */
import { readMediaBytes } from './response-reader.js';

const EBML=0x1a45dfa3,SEGMENT=0x18538067,INFO=0x1549a966,TRACKS=0x1654ae6b,CLUSTER=0x1f43b675;
const HEAD_LIMITS=[1<<20,4<<20,24<<20];

async function head(url,length){
  const response=await fetch(url,{headers:{Range:`bytes=0-${length-1}`}});
  return new Uint8Array(await readMediaBytes(response,length));
}

function vint(bytes,start,id=false){
  const first=bytes[start];if(!first)throw new Error('invalid EBML integer');
  let width=1,marker=0x80;while(!(first&marker)){width++;marker>>=1;}
  if(width>8||start+width>bytes.length||(id&&width>4))throw new Error('incomplete EBML header');
  let value=id?first:first&(marker-1),unknown=!id&&value===marker-1;
  for(let index=1;index<width;index++){value=value*256+bytes[start+index];unknown=unknown&&bytes[start+index]===255;}
  if(!unknown&&!Number.isSafeInteger(value))throw new Error('unsafe EBML size');
  return {width,value:unknown?Infinity:value};
}

function* elements(bytes,start=0,end=bytes.length){
  while(start<Math.min(end,bytes.length)){
    const id=vint(bytes,start,true),size=vint(bytes,start+id.width),body=start+id.width+size.width;
    const finish=body+size.value;
    if(finish<=start||finish>end)throw new Error('invalid EBML element size');
    yield {id:id.value,start:body,end:finish};
    start=finish;
  }
}

function uint(bytes,element){
  if(element.end>bytes.length||element.end-element.start>8)throw new Error('incomplete EBML value');
  let value=0;for(let index=element.start;index<element.end;index++)value=value*256+bytes[index];
  if(!Number.isSafeInteger(value))throw new Error('unsafe EBML value');return value;
}
function float(bytes,element){
  const size=element.end-element.start;if(element.end>bytes.length)throw new Error('incomplete EBML duration');
  const view=new DataView(bytes.buffer,bytes.byteOffset+element.start,size);
  if(size===4)return view.getFloat32(0);if(size===8)return view.getFloat64(0);throw new Error('invalid EBML duration');
}

function metadata(bytes){
  let segment=null;
  for(const element of elements(bytes,0,Infinity)){if(element.id===SEGMENT){segment=element;break;}}
  if(!segment) return null;
  let scale=1e6,duration=null;const tracks=[],clusters=[];
  for(const element of elements(bytes,segment.start,segment.end)){
    if(element.id===INFO){
      for(const child of elements(bytes,element.start,element.end)){
        if(child.id===0x2ad7b1)scale=uint(bytes,child);
        if(child.id===0x4489)duration=float(bytes,child);
      }
    }else if(element.id===TRACKS){
      for(const entry of elements(bytes,element.start,element.end)){
        if(entry.id!==0xae)continue;
        const track={delay:0};
        for(const child of elements(bytes,entry.start,entry.end)){
          if(child.id===0xd7)track.number=uint(bytes,child);
          if(child.id===0x83)track.type=uint(bytes,child);
          if(child.id===0x56aa)track.delay=uint(bytes,child);
        }
        tracks.push(track);
      }
    }else if(element.id===CLUSTER)clusters.push(element);
  }
  const track=tracks.find(item=>item.type===1)||tracks.find(item=>item.type===2);
  const audio=tracks.filter(item=>item.type===2),origins=new Map(),decodedOrigins=new Map();
  if(!track||!(scale>0)||!Number.isFinite(duration)||duration<=0)return null;
  const result=()=>{
    const origin=origins.get(track.number);
    if(!Number.isFinite(origin))return null;
    const offsets=audio.map(item=>origins.has(item.number)?-origins.get(item.number)||0:null);
    const decodedOffsets=audio.map(item=>decodedOrigins.has(item.number)?-decodedOrigins.get(item.number)||0:null);
    return Object.freeze({presentationTimestampOffset:-origin||0,duration:Math.max(0,duration*scale/1e9-origin),
      ...(Number.isFinite(offsets[0])?{audioPresentationTimestampOffset:offsets[0]}:{}),
      ...(offsets.length?{audioPresentationTimestampOffsets:Object.freeze(offsets)}:{}),
      ...(decodedOffsets.length?{decoderAudioPresentationTimestampOffsets:Object.freeze(decodedOffsets)}:{}),
    });
  };
  for(const cluster of clusters){
    let clusterTime=0;
    for(const element of elements(bytes,cluster.start,cluster.end)){
      if(element.id===0xe7){clusterTime=uint(bytes,element);continue;}
      const blocks=element.id===0xa0?[...elements(bytes,element.start,element.end)].filter(child=>child.id===0xa1):element.id===0xa3?[element]:[];
      for(const block of blocks){
        const number=vint(bytes,block.start),time=block.start+number.width;
        if(time+3>Math.min(block.end,bytes.length))return result();
        const selected=number.value===track.number?track:audio.find(item=>item.number===number.value);
        if(!selected||origins.has(selected.number))continue;
        const relative=new DataView(bytes.buffer,bytes.byteOffset+time,2).getInt16(0);
        // CodecDelay is in ns. Opus's encoded/HTML presentation clock begins
        // before its first block; its decoded sample origin is kept separately.
        const origin=((clusterTime+relative)*scale-selected.delay)/1e9;
        origins.set(selected.number,origin);
        // Opus decoding consumes CodecDelay/pre-skip. FFmpeg and Web Audio's
        // first decoded sample begin at this block time, while HTML's encoded
        // stream clock still includes that delay before the block.
        decodedOrigins.set(selected.number,(clusterTime+relative)*scale/1e9);
        if(origins.has(track.number)&&audio.every(item=>origins.has(item.number)))return result();
      }
    }
  }
  return result();
}

/* undefined means another container; null means no supported timestamp proof.
   Unknown-size live segments without Duration remain explicitly unsupported. */
export async function webmPresentationMetadata(url){
  const signature=await head(url,16);
  if(signature.length<4||new DataView(signature.buffer,signature.byteOffset,4).getUint32(0)!==EBML)return undefined;
  let best=null;
  for(const length of HEAD_LIMITS){
    const bytes=await head(url,length);
    try{
      const result=metadata(bytes);
      if(result){best=result;if(!result.audioPresentationTimestampOffsets?.includes(null))return result;}
    }catch(error){/* Larger bounded header may complete this element. */}
    if(bytes.length<length)break;
  }
  return best;
}
