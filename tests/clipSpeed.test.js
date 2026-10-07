import { beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { State } from '../src/state.js';
import { Seq } from '../src/sequence.js';
import { planClipGesturePreview } from '../src/timeline-gesture-transaction.js';
import { buildExportSnapshot } from '../src/delivery-job.js';

const ExportPlan=createRequire(import.meta.url)('../electron/export-plan.js');

beforeEach(()=>{
  State.clips=[];
  State.videoTracks=[{name:'V1'}];
  State.cues=[];
  State.externalAudioEnd=0;
  State.duration=0;
});

describe('片段速度與反轉共用時間域',()=>{
  it('速度改變時間軸長度，反轉使來源時間遞減，存檔及 Undo 快照保留欄位',()=>{
    const clip={id:'a',name:'A',path:'C:/a.mov',in:2,out:10,dur:12,offset:5,vtrack:0,speed:2,reverse:true};
    State.clips=[clip];
    expect(Seq.len(clip)).toBe(4);
    expect(Seq.clipEnd(clip)).toBe(9);
    expect(Seq.toSource(6,clip)).toBe(8);
    expect(Seq.toTimeline(8,clip)).toBe(6);
    expect(Seq.snapshot()[0]).toMatchObject({speed:2,reverse:true});
    const snapshot=Seq.snapshot();
    clip.speed=1;clip.reverse=false;
    Seq.restore(snapshot);
    expect(Seq.byId('a')).toMatchObject({speed:2,reverse:true});
  });

  it('反向切割與左右修剪保持來源區間、時間軸長度和淡化起點',()=>{
    const clip={id:'a',name:'A',path:'C:/a.mov',in:2,out:10,dur:12,offset:5,vtrack:0,speed:2,reverse:true};
    State.clips=[clip];
    const split=Seq.planSplit(clip,7);
    expect(split.left).toMatchObject({in:6});
    expect(split.right).toMatchObject({in:2,out:6,offset:7,fadeSourceOffset:2});
    const frame=x=>x;
    expect(planClipGesturePreview({mode:'clip-l',original:{...clip,duration:12,type:'video'},deltaTime:1,snapFrame:frame})).toMatchObject({offset:6,in:2,out:8});
    expect(planClipGesturePreview({mode:'clip-r',original:{...clip,duration:12,type:'video'},deltaTime:1,snapFrame:frame})).toMatchObject({offset:5,in:0,out:10});
  });

  it('交付範圍裁切依反向來源座標計算，影片變速與反轉進入 ffmpeg filtergraph',()=>{
    const clip={id:'a',name:'A',path:'C:/a.mov',type:'video',in:2,out:10,dur:12,offset:5,vtrack:0,speed:2,reverse:true};
    const state={clips:[clip],videoTracks:[{visible:true}],audioProject:null,exportIn:6,exportOut:8};
    const snapshot=buildExportSnapshot({state,sequenceEnd:9});
    expect(snapshot.clips[0]).toMatchObject({in:4,out:8,offset:0,speed:2,reverse:true});
    expect(snapshot.clips[0].fadeSourceOffset).toBe(1);
    const plan=ExportPlan.buildDeliveryArgv({
      format:'mp4',width:320,height:180,fps:25,duration:2,videoKbps:800,
      clips:snapshot.clips,videoTracks:snapshot.videoTracks,audioPlan:null,
      assFileName:null,outPath:'C:/out.mp4',
    },{hasAudioStream:()=>false});
    const graph=plan.args[plan.args.indexOf('-filter_complex')+1];
    expect(graph).toContain('reverse,setpts=(PTS-STARTPTS)/2.000000');
  });
});

const ffmpeg=path.join(process.cwd(),'electron/ffmpeg/ffmpeg.exe');
describe.skipIf(!existsSync(ffmpeg))('變速反轉實際交付影格',()=>{
  it('2 倍速反轉使藍色片尾先於紅色片頭，長度縮成一半',()=>{
    const dir=mkdtempSync(path.join(tmpdir(),'subtool-speed-'));
    const run=args=>{
      const result=spawnSync(ffmpeg,['-hide_banner','-nostdin','-loglevel','error',...args],{encoding:null,maxBuffer:2*1024*1024,timeout:30000});
      if(result.status!==0) throw new Error(String(result.stderr));
      return result.stdout;
    };
    try{
      const source=path.join(dir,'source.mp4'),output=path.join(dir,'output.mp4');
      run(['-y','-f','lavfi','-i',"color=c=red:s=64x64:r=10:d=2,drawbox=c=blue:t=fill:enable='gte(t,1)'",'-c:v','libx264','-pix_fmt','yuv420p',source]);
      const plan=ExportPlan.buildDeliveryArgv({format:'mp4',width:64,height:64,fps:10,duration:1,videoKbps:800,
        clips:[{path:source,type:'video',in:0,out:2,offset:0,vtrack:0,speed:2,reverse:true}],
        videoTracks:[{vt:0}],audioPlan:null,outPath:output},{hasAudioStream:()=>false});
      run(plan.args);
      const pixel=seconds=>run(['-i',output,'-ss',String(seconds),'-frames:v','1','-vf','scale=1:1','-pix_fmt','rgb24','-f','rawvideo','-']);
      const first=pixel(0.05),last=pixel(0.85);
      expect(first[2]).toBeGreaterThan(first[0]+100);
      expect(last[0]).toBeGreaterThan(last[2]+100);
    }finally{rmSync(dir,{recursive:true,force:true});}
  },60000);
});
