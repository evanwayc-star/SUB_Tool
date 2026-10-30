import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoxParser, createFile } from 'mp4box';
import { demuxIndex, presentationSamples, SampleReader } from '../src/decode/demux.js';
import { clearSourceFrameIndexes, sourceFrameWindow, sourcePresentationMetadata } from '../src/decode/source-frame-index.js';

afterEach(()=>{clearSourceFrameIndexes();vi.unstubAllGlobals();vi.restoreAllMocks();});

const LARGE_PCM_COUNT=356872000;
function children(bytes,start=0,end=bytes.length){
  const result=[];
  for(let position=start;position+8<=end;){
    const size=bytes.readUInt32BE(position),type=bytes.toString('latin1',position+4,position+8);
    if(size<8||position+size>end)throw new Error('invalid fixture box');
    result.push({type,position,body:position+8,end:position+size});position+=size;
  }
  return result;
}

/* A sparse sample-table oracle: tiny moov, identifiable video byte ranges,
   and six long constant-size PCM streams. Codec decoding is not substituted
   or exercised here; only Range delivery varies from the public caller. */
function fixture({video=true,audioCount=6,large=true,timing=null,unregisteredVideo=false,unsupportedStream=-1,tailMoov=false,secondVideo=false,audioCodec='twos',reorderedChunks=false}={}){
  const file=createFile();file.init({brands:['iso4'],timescale:1000,duration:7434833});
  let nextId=1;
  if(video){
    const id=file.addTrack({id:nextId++,type:'avc3',hdlr:'vide',width:64,height:36,timescale:2400,duration:167,media_duration:400});
    const table=file.getTrackById(id).mdia.minf.stbl;
    table.stsz.sample_size=0;table.stsz.sample_sizes=[4,5,6,7];
    table.stco.chunk_offsets=reorderedChunks?[4101,4096,4112,4105]:[4096];
    table.stsc.first_chunk=[1];table.stsc.samples_per_chunk=[reorderedChunks?1:4];table.stsc.sample_description_index=[1];
    table.stts.sample_counts=[4];table.stts.sample_deltas=[100];
  }
  if(secondVideo){
    const id=file.addTrack({id:nextId++,type:'avc3',hdlr:'vide',width:128,height:72,timescale:2400,duration:167,media_duration:400});
    const table=file.getTrackById(id).mdia.minf.stbl;
    table.stsz.sample_size=0;table.stsz.sample_sizes=[2,2];table.stco.chunk_offsets=[4118];
    table.stsc.first_chunk=[1];table.stsc.samples_per_chunk=[2];table.stsc.sample_description_index=[1];
    table.stts.sample_counts=[2];table.stts.sample_deltas=[200];
  }
  const audioStart=4118+(secondVideo?4:0);
  for(let stream=0;stream<audioCount;stream++){
    const count=large?LARGE_PCM_COUNT:5;
    const id=file.addTrack({id:nextId++,type:'mp4a',hdlr:'soun',channel_count:6,samplesize:16,
      samplerate:48000<<16,timescale:timing?.timescale||(timing?1000:48000),duration:7434833,media_duration:count});
    const trak=file.getTrackById(id),table=trak.mdia.minf.stbl;
    table.stsz.sample_size=12;table.stsz.sample_sizes=new Array(5).fill(12);
    table.boxes=table.boxes.filter(box=>box.type!=='stco');delete table.stco;
    table.addBox(new BoxParser.box.co64()).chunk_offsets=[audioStart+stream*count*12];
    table.stsc.first_chunk=[1];table.stsc.samples_per_chunk=[count];table.stsc.sample_description_index=[1];
    table.stts.sample_counts=timing?.counts||[count];table.stts.sample_deltas=timing?.deltas||[1];
    const edits=trak.addBox(new BoxParser.box.edts()).addBox(new BoxParser.box.elst());
    if(timing?.editVersion1)edits.version=1;
    edits.entries=[{segment_duration:timing?.emptyDuration??(5+stream)*1000,media_time:-1,media_rate_integer:1,media_rate_fraction:0},
      {segment_duration:7424833,media_time:timing?.mediaTime||0,media_rate_integer:stream===unsupportedStream?2:1,media_rate_fraction:0}];
    if(timing?.unsafeEdit)edits.entries[0].segment_duration=2**53;
    if(timing){
      const ctts=table.addBox(new BoxParser.box.ctts());
      ctts.sample_counts=timing.cttsCounts;ctts.sample_offsets=timing.offsets;
    }
  }
  file.moov.boxes=file.moov.boxes.filter(box=>box.type!=='mvex');delete file.moov.mvex;
  const header=Buffer.from(file.getBuffer().buffer);
  const moov=children(header).find(box=>box.type==='moov');
  for(const trak of children(header,moov.body,moov.end).filter(box=>box.type==='trak')){
    const mdia=children(header,trak.body,trak.end).find(box=>box.type==='mdia');
    const md=children(header,mdia.body,mdia.end),handler=md.find(box=>box.type==='hdlr');
    if(header.toString('latin1',handler.body+8,handler.body+12)!=='soun'){
      const tkhd=children(header,trak.body,trak.end).find(box=>box.type==='tkhd');
      if(unregisteredVideo&&header.readUInt32BE(tkhd.body+12)===1){
        const minf=md.find(box=>box.type==='minf'),stbl=children(header,minf.body,minf.end).find(box=>box.type==='stbl');
        const stsd=children(header,stbl.body,stbl.end).find(box=>box.type==='stsd');header.write('apch',stsd.body+12);
      }
      continue;
    }
    const minf=md.find(box=>box.type==='minf');
    const stbl=children(header,minf.body,minf.end).find(box=>box.type==='stbl');
    const sampleBoxes=children(header,stbl.body,stbl.end),stsz=sampleBoxes.find(box=>box.type==='stsz');
    const stsd=sampleBoxes.find(box=>box.type==='stsd');header.write(audioCodec,stsd.body+12);
    expect(header.toString('latin1',stsd.body+12,stsd.body+16)).toBe(audioCodec);
    header.writeUInt32BE(large?LARGE_PCM_COUNT:5,stsz.body+8);
    const co64=sampleBoxes.find(box=>box.type==='co64');
    const trackIdBox=children(header,trak.body,trak.end).find(box=>box.type==='tkhd');
    const stream=header.readUInt32BE(trackIdBox.body+12)-(1+(video?1:0)+(secondVideo?1:0));
    expect(header.readBigUInt64BE(co64.body+8)).toBe(BigInt(audioStart+stream*(large?LARGE_PCM_COUNT:5)*12));
  }
  const prefix=Buffer.alloc(audioStart);header.copy(prefix);
  prefix.writeUInt32BE(4096-16-header.length,header.length);prefix.write('free',header.length+4);
  const mediaEnd=audioStart+audioCount*(large?LARGE_PCM_COUNT:5)*12;
  const tail=tailMoov?header.subarray(moov.position,moov.end):Buffer.alloc(0),size=mediaEnd+tail.length;
  if(tailMoov)prefix.write('free',moov.position+4);
  prefix.writeUInt32BE(1,4080);prefix.write('mdat',4084);prefix.writeBigUInt64BE(BigInt(mediaEnd-4080),4088);
  for(let index=4096;index<audioStart;index++)prefix[index]=index%251;
  const reads=[];
  vi.stubGlobal('fetch',vi.fn(async(unused,{headers}={})=>{
    const range=/^bytes=(\d+)-(\d+)$/.exec(headers?.Range||'');if(!range)throw new Error('Range required');
    const start=Number(range[1]),end=Math.min(size,Number(range[2])+1);
    const bytes=Buffer.alloc(Math.max(0,end-start));
    if(start<prefix.length)prefix.copy(bytes,0,start,Math.min(prefix.length,end));
    if(tailMoov&&end>mediaEnd){
      const from=Math.max(start,mediaEnd);tail.copy(bytes,from-start,from-mediaEnd,Math.min(tail.length,end-mediaEnd));
    }
    reads.push({start,end});
    return new Response(bytes,{status:206,headers:{'content-length':String(bytes.length)}});
  }));
  // Stop the unfixed parser before its 356M-entry allocation; everything
  // beneath the public demux interface otherwise remains the actual parser.
  const parser=BoxParser.box.stsz.prototype.parse,dangerous=[];
  vi.spyOn(BoxParser.box.stsz.prototype,'parse').mockImplementation(function(stream){
    const view=new DataView(stream.buffer,stream.byteOffset);
    const count=view.getUint32(stream.position+8);
    if(count===LARGE_PCM_COUNT){dangerous.push(count);throw new Error('TEST_DENSE_PCM_ALLOCATION_GUARD');}
    return parser.call(this,stream);
  });
  return {prefix,reads,dangerous,url:'memory:compact'};
}

describe('compact MOV metadata through actual MP4Box and public callers',()=>{
  it('MP4 chunk 的檔案位置不同於解碼順序時，串流仍交出每顆完整樣本',async()=>{
    const resource=fixture({reorderedChunks:true,audioCount:0});
    const raw=await demuxIndex(resource.url);
    expect(raw.index.map(sample=>sample.offset)).toEqual([4101,4096,4112,4105]);
    expect(raw.index.map(sample=>sample.timestamp)).toEqual([0,41667,83333,125000]);
    const reader=new SampleReader(resource.url,raw.index,raw.maxEnd);
    try{
      reader.ensure(0);
      await vi.waitFor(()=>expect(reader.data(0)).not.toBeNull());
      raw.index.forEach((sample,index)=>{
        expect(Buffer.from(reader.data(index))).toEqual(resource.prefix.subarray(sample.offset,sample.offset+sample.size));
      });
      expect(resource.reads.at(-1)).toEqual({start:4096,end:4118});
    }finally{reader.dispose();}
  });

  it('a second registered video never replaces the first native ProRes source clock or frame',async()=>{
    const resource=fixture({unregisteredVideo:true,secondVideo:true,audioCount:0});
    const raw=await demuxIndex(resource.url);
    expect(raw.config).toEqual({codec:'apch',codedWidth:64,codedHeight:36,description:undefined});
    expect(raw.index).toHaveLength(4);
    expect(await sourceFrameWindow(resource.url,.1)).toEqual({start:.083333,end:.125});
  });

  it('ProRes vide handler provides actual frame evidence even when MP4Box has no codec adapter',async()=>{
    const resource=fixture({unregisteredVideo:true});
    const raw=await demuxIndex(resource.url);
    expect(raw.config).toEqual({codec:'apch',codedWidth:64,codedHeight:36,description:undefined});
    expect(raw.info.hasVideo).toBe(true);expect(raw.index).toHaveLength(4);
    expect(await sourceFrameWindow(resource.url,.1)).toEqual({start:.083333,end:.125});
    expect(resource.dangerous).toEqual([]);
  });

  it('six huge PCM streams retain all origins while video indexing and payload remain exact',async()=>{
    const resource=fixture();
    const raw=await demuxIndex(resource.url);
    expect(raw.index.map(sample=>({offset:sample.offset,size:sample.size,timestamp:sample.timestamp,duration:sample.duration})))
      .toEqual([0,1,2,3].map((index)=>({offset:[4096,4100,4105,4111][index],size:index+4,
        timestamp:Math.round(index*100/2400*1e6),duration:41667})));
    expect(raw.keyIdx).toEqual([0,1,2,3]);expect(raw.info.hasVideo).toBe(true);
    expect(raw.info.audioPresentationTimestampOffsets).toEqual([-5,-6,-7,-8,-9,-10]);
    expect(raw.info.decoderAudioPresentationTimestampOffsets).toEqual([-5,-6,-7,-8,-9,-10]);
    const reader=new SampleReader(resource.url,raw.index,raw.maxEnd);reader.ensure(0);
    await vi.waitFor(()=>expect(reader.data(0)).not.toBeNull());
    expect(Buffer.from(reader.data(0))).toEqual(resource.prefix.subarray(4096,4100));reader.dispose();
    expect(resource.dangerous).toEqual([]);
  });

  it('source frame evidence caches a successful real index and preserves the 24fps boundary',async()=>{
    const resource=fixture();
    expect(await sourceFrameWindow(resource.url,.1)).toEqual({start:.083333,end:.125});
    const count=resource.reads.length;
    expect(await sourceFrameWindow(resource.url,.12)).toEqual({start:.083333,end:.125});
    expect(resource.reads).toHaveLength(count);
    const metadata=await sourcePresentationMetadata(resource.url);
    expect(metadata.duration).toBe(7434.833);expect(metadata.audioPresentationTimestampOffsets).toEqual([-5,-6,-7,-8,-9,-10]);
    expect(resource.dangerous).toEqual([]);
  });

  it('a tail moov after a 64-bit mdat keeps source addresses and bounded reads',async()=>{
    const resource=fixture({tailMoov:true});
    const raw=await demuxIndex(resource.url);
    expect(raw.index[0].offset).toBe(4096);expect(raw.index.at(-1).offset).toBe(4111);
    expect(await sourceFrameWindow(resource.url,.1)).toEqual({start:.083333,end:.125});
    expect(resource.reads.some(read=>read.start>0xffffffff)).toBe(true);
    expect(resource.reads.reduce((sum,read)=>sum+read.end-read.start,0)).toBeLessThan(1024*1024);
  });

  it('audio-only metadata has real clocks and container end without claiming PCM frames',async()=>{
    const resource=fixture({video:false});
    const raw=await demuxIndex(resource.url,{allowAudio:true,metadataOnly:true});
    expect(raw.index).toEqual([]);expect(raw.keyIdx).toEqual([]);expect(raw.config).toBeNull();
    expect(raw.info.hasVideo).toBe(false);expect(raw.info.nbSamples).toBe(LARGE_PCM_COUNT);
    expect(raw.info.audioPresentationTimestampOffsets).toEqual([-5,-6,-7,-8,-9,-10]);
    const metadata=await sourcePresentationMetadata(resource.url);
    expect(metadata.presentationTimestampOffset).toBe(-5);expect(metadata.duration).toBe(7429.833);
    expect(await sourceFrameWindow(resource.url,1)).toBeNull();expect(resource.dangerous).toEqual([]);
  });

  it('compact STTS/CTTS intersections use minimum CTS beyond the first run',async()=>{
    const resource=fixture({video:false,audioCount:1,large:false,timing:{counts:[2,3],deltas:[10,20],
      cttsCounts:[1,2,2],offsets:[130,85,50],mediaTime:20}});
    const raw=await demuxIndex(resource.url,{allowAudio:true,metadataOnly:true});
    expect(raw.info.audioPresentationTimestampOffset).toBe(-5.07);
    expect(raw.info.audioPresentationTimestampOffsets).toEqual([-5.07]);
  });

  it('signed CTTS v1 and ELST v1 preserve later-run minimum and empty-edit origin',async()=>{
    const resource=fixture({video:false,audioCount:1,large:false,timing:{counts:[2,3],deltas:[100,200],
      cttsCounts:[1,2,2],offsets:[300,185,-150],mediaTime:20,editVersion1:true}});
    const raw=await demuxIndex(resource.url,{allowAudio:true,metadataOnly:true});
    expect(raw.info.audioPresentationTimestampOffset).toBe(-5.23);
    expect(raw.info.presentationStartUs).toBe(5000000);
  });

  it('CTTS v0 offsets with a high bit remain positive container ticks',async()=>{
    const resource=fixture({video:false,audioCount:1,large:false,timing:{counts:[5],deltas:[1],
      cttsCounts:[5],offsets:[0x80000010],mediaTime:20}});
    const raw=await demuxIndex(resource.url,{allowAudio:true,metadataOnly:true});
    expect(raw.info.audioPresentationTimestampOffset).toBe(-(5+(0x80000010-20)/1000));
  });

  it('unsupported edit metadata keeps a null slot in original sound-stream order',async()=>{
    const resource=fixture({audioCount:3,unsupportedStream:1});
    const raw=await demuxIndex(resource.url,{metadataOnly:true});
    expect(raw.info.audioPresentationTimestampOffsets).toEqual([-5,null,-7]);
    expect(raw.info.decoderAudioPresentationTimestampOffsets).toEqual([-5,null,-7]);
  });

  it('an ELST v1 tick outside exact JavaScript integer range never publishes a guessed source clock',async()=>{
    const resource=fixture({video:false,audioCount:1,large:false,timing:{counts:[5],deltas:[1],
      cttsCounts:[5],offsets:[0],unsafeEdit:true}});
    const raw=await demuxIndex(resource.url,{allowAudio:true,metadataOnly:true});
    expect(raw.info.audioPresentationTimestampOffsets).toEqual([null]);
    expect(raw.info.presentationOffsetUs).toBeNull();
    expect(await sourcePresentationMetadata(resource.url)).toBeNull();
  });

  it('a failed Range read remains retryable for the same source URL',async()=>{
    const resource=fixture();fetch.mockRejectedValueOnce(new Error('temporary Range failure'));
    expect(await sourceFrameWindow(resource.url,.1)).toBeNull();
    expect(await sourceFrameWindow(resource.url,.1)).toEqual({start:.083333,end:.125});
    expect(resource.dangerous).toEqual([]);
  });

  it('the default PCM index retains sample addresses and edit-list timing',async()=>{
    const resource=fixture({video:false,audioCount:1,large:false});
    const raw=await demuxIndex(resource.url,{allowAudio:true});
    expect(raw.index).toHaveLength(5);expect(raw.index[0].offset).toBe(4118);expect(raw.index[0].size).toBe(12);
    expect(presentationSamples(raw.index,raw.info)[0].timestamp).toBe(5000000);
    expect(raw.info.audioPresentationTimestampOffset).toBe(-5);
  });

  it('the default AAC index retains encoded preroll while metadata uses its active decoder origin',async()=>{
    const resource=fixture({video:false,audioCount:1,large:false,audioCodec:'mp4a',timing:{counts:[5],deltas:[1024],
      cttsCounts:[5],offsets:[0],mediaTime:1024,emptyDuration:0,timescale:48000}});
    const raw=await demuxIndex(resource.url,{allowAudio:true});
    expect(raw.index).toHaveLength(5);
    expect(presentationSamples(raw.index,raw.info)[0].timestamp).toBe(-21333);
    expect(raw.info.audioPresentationTimestampOffset).toBe(0);
    const metadata=await sourcePresentationMetadata(resource.url);
    expect(metadata.presentationTimestampOffset).toBe(0);
    expect(metadata.decoderAudioPresentationTimestampOffsets).toEqual([0]);
  });
});
