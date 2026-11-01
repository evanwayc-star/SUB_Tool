// @vitest-environment jsdom
import {it,expect,vi,afterAll} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
it('速度視窗等待播放器時，存檔與自動備份都使用已提交片長收尾',async()=>{
vi.useFakeTimers();
window.subtool={isDesktop:true,saveProject:vi.fn(async()=> 'C:/test.subtool'),writeProject:vi.fn(async()=> 'ok'),configSave:vi.fn()};
document.body.innerHTML=new DOMParser().parseFromString(fs.readFileSync(path.resolve('index.html'),'utf8'),'text/html').body.innerHTML;
HTMLMediaElement.prototype.pause=vi.fn(); HTMLMediaElement.prototype.load=vi.fn();
HTMLCanvasElement.prototype.getContext=()=>new Proxy({measureText:()=>({width:1})},{get:(t,k)=>t[k]||(()=>{})});
const {State}=await import('../src/state.js'),{History}=await import('../src/history.js');
const {Media}=await import('../src/media.js'),{Project}=await import('../src/project.js');
const {showClipSpeed}=await import('../src/menus.js');
const clip={id:'v',name:'video',path:'C:/video.mov',in:0,out:10,dur:10,offset:0,vtrack:0,speed:1};
Object.assign(State,{tracks:[{name:'字幕',visible:true}],cues:[{id:'cue',text:'test',start:9,end:10,track:0,_tempEnd:true}],notes:[],videoTracks:[{name:'V1',visible:true}],clips:[clip],externalAudioState:[],duration:10,exportIn:null,exportOut:null,fps:25,dropFrame:false});
History.reset();vi.spyOn(Media,'displayTime').mockReturnValue(0);
await Project.saveAs();
const decode=encoded=>JSON.parse(Buffer.from(encoded,'base64').subarray(2).toString('utf16le'));
expect(decode(window.subtool.saveProject.mock.calls[0][1]).cues[0].end).toBe(10);
vi.spyOn(Media,'refreshClipPlayback').mockImplementation(()=>new Promise(()=>{}));
showClipSpeed(clip);
document.getElementById('clipSpeedPercent').value='50';
Array.from(document.querySelectorAll('#modalFoot button')).find(b=>b.textContent.trim()==='套用').click();
expect(State.clips[0].speed).toBe(.5);expect(State.duration).toBe(20);
vi.advanceTimersByTime(180000);for(let i=0;i<20;i++)await Promise.resolve();
expect(window.subtool.writeProject).toHaveBeenCalled();
const b=Buffer.from(window.subtool.writeProject.mock.calls.at(-1)[1],'base64');const d=JSON.parse(b.subarray(2).toString('utf16le'));

expect(d.clips[0].speed??1).toBe(1); expect(d.cues[0].end).toBe(10);
await Project.saveAs();
expect(decode(window.subtool.saveProject.mock.calls.at(-1)[1]).cues[0].end).toBe(10);
expect(State.cues[0]).toMatchObject({start:9,end:10,_tempEnd:true});
document.querySelector('#modalFoot button').click();
expect(clip.speed).toBe(1);expect(State.duration).toBe(10);
});

it('推導片長保留虛擬片長、待復原影片和外部音訊',async()=>{
const {State}=await import('../src/state.js');
const {snapshotTimelineDuration}=await import('../src/subtitle-model.js');
Object.assign(State,{clips:[],externalAudioState:[],cues:[],duration:30});
expect(snapshotTimelineDuration({clips:[],externalAudioState:[],cues:[]})).toBe(30);
const clip={in:0,out:10,offset:0,speed:1};
Object.assign(State,{clips:[clip],duration:30});
expect(snapshotTimelineDuration({clips:[clip],externalAudioState:[],cues:[]})).toBe(30);
State.duration=10;
const pending={in:0,out:5,offset:25,speed:1};
expect(snapshotTimelineDuration({clips:[clip,pending],externalAudioState:[],cues:[]})).toBe(30);
const audio={duration:12,trimStart:0,trimEnd:12,offset:24};
expect(snapshotTimelineDuration({clips:[clip],externalAudioState:[audio],cues:[]})).toBe(36);
});

afterAll(()=>{vi.restoreAllMocks();vi.clearAllTimers();vi.useRealTimers();delete window.subtool;});
