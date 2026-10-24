// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks=vi.hoisted(()=>({
  media:{tracks:[]},transcribe:vi.fn(),decode:vi.fn(),open:vi.fn(),close:vi.fn(),toast:vi.fn(),
}));
vi.mock('../src/media.js',()=>({Media:mocks.media}));
vi.mock('../src/project.js',()=>({Project:{captureWorkspaceOwnership:()=>()=>true}}));
vi.mock('../src/events.js',()=>({emit:vi.fn(),on:vi.fn()}));
vi.mock('../src/history.js',()=>({recordHistory:vi.fn()}));
vi.mock('../src/ui.js',()=>({openModal:mocks.open,closeModal:mocks.close,showToast:mocks.toast}));
vi.mock('../src/audio-engine.js',()=>({AudioEngine:{markSourceAudioBuffer:buffer=>buffer,
  inheritSourceAudioClock:(_original,copy)=>copy,normalizeSourceAudioBuffer:async buffer=>buffer,decodeAudioData:mocks.decode}}));
vi.mock('../src/speech-recognition-engine.js',async importOriginal=>({...await importOriginal(),transcribeAudioStream:mocks.transcribe}));

import { State, setSelection } from '../src/state.js';
import { Seq } from '../src/sequence.js';
import { clearAsrSession, getAsrConfig, openSpeechRecognitionDialog, saveAsrConfig } from '../src/speech-recognition.js';

const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const element=id=>document.getElementById(id);
const switchProvider=provider=>{element('asrProvider').value=provider;element('asrProvider').dispatchEvent(new Event('change',{bubbles:true}));};
const pcm=value=>({sampleRate:16000,numberOfChannels:1,length:160,duration:.01,getChannelData:()=>new Float32Array(160).fill(value)});
const source=(id,extra={})=>({id,name:id+'.wav',audioSourceId:'audio-'+id,audioSrc:'runtime-'+id,
  path:'C:/media/'+id+'.wav',in:0,out:.01,duration:.01,offset:0,...extra});
const open=async target=>{openSpeechRecognitionDialog(target);await tick();return mocks.open.mock.calls.at(-1);};
const start=()=>mocks.open.mock.calls.at(-1)[2].find(button=>button.primary).act();

beforeEach(()=>{
  vi.clearAllMocks();clearAsrSession();localStorage.clear();document.body.innerHTML='';
  mocks.media.tracks=[];mocks.transcribe.mockReset().mockResolvedValue([]);mocks.decode.mockReset();
  mocks.open.mockImplementation((_title,html)=>{document.body.innerHTML=html+'<div id="modalFoot"></div>';});
  State.clips=[];State.externalAudioState=[];State.cues=[];State.tracks=[{name:'字幕',locked:false}];
  setSelection();
  saveAsrConfig({...getAsrConfig(),provider:'google',googleApiKey:'saved-google',prompt:'已保存提示'});
});
afterEach(()=>{clearAsrSession();vi.unstubAllGlobals();});

describe('辨識設定草稿由同一 live dialog 保留',()=>{
  it('往返供應商保留各自 key 與導引，開始使用保留的 Azure 草稿',async()=>{
    const target=source('draft',{audioBuffer:pcm(.4)});State.clips=[target];await open(target);
    element('asrApiKey').value='draft-google';element('asrPrompt').value='Google 草稿';
    switchProvider('azure');element('asrApiKey').value='draft-azure';element('asrPrompt').value='專名甲，專名乙';
    element('asrAzureRegion').value='eastasia';element('asrAzureProfanity').value='Masked';
    switchProvider('elevenlabs');element('asrApiKey').value='draft-elevenlabs';element('asrPrompt').value='Scribe 草稿';
    element('asrElevenLabsSpeakers').value='3';element('asrElevenLabsAudioEvents').checked=true;
    switchProvider('google');expect(element('asrApiKey').value).toBe('draft-google');expect(element('asrPrompt').value).toBe('Google 草稿');
    switchProvider('elevenlabs');expect(element('asrApiKey').value).toBe('draft-elevenlabs');expect(element('asrPrompt').value).toBe('Scribe 草稿');
    expect(element('asrElevenLabsSpeakers').value).toBe('3');expect(element('asrElevenLabsAudioEvents').checked).toBe(true);
    switchProvider('azure');expect(element('asrApiKey').value).toBe('draft-azure');expect(element('asrPrompt').value).toBe('專名甲，專名乙');
    expect(element('asrAzureRegion').value).toBe('eastasia');expect(element('asrAzureProfanity').value).toBe('Masked');
    await start();expect(mocks.transcribe).toHaveBeenCalledWith(expect.objectContaining({provider:'azure',apiKey:'draft-azure',
      azureRegion:'eastasia',azurePhrases:['專名甲','專名乙'],azureProfanity:'Masked'}));
  });

  it.each(['cancel','replacement'])('%s 放棄本次草稿，不污染已保存設定或重開視窗',async reason=>{
    const target=source('cancel',{audioBuffer:pcm(.4)});State.clips=[target];const before=getAsrConfig();
    const call=await open(target);element('asrApiKey').value='private-unsaved';element('asrPrompt').value='尚未確認';
    switchProvider('azure');element('asrApiKey').value='private-azure';switchProvider('google');
    if(reason==='cancel')call[2][0].act();else call[3].onReplaced();
    expect(getAsrConfig()).toEqual(before);await open(target);
    expect(element('asrApiKey').value).toBe('saved-google');expect(element('asrPrompt').value).toBe('已保存提示');
    expect(mocks.transcribe).not.toHaveBeenCalled();
  });
});

describe('辨識來源的接受入口共用 runtime 聲道',()=>{
  it.each(['toolbar','preferred','selector'])('%s 使用同一 preferCache 素材的全部已就緒聲道',async entry=>{
    saveAsrConfig({...getAsrConfig(),provider:'builtin'});
    const target=source('cached',{preferCache:true}),other=source('other',{audioBuffer:pcm(.9)});
    State.externalAudioState=[target];State.clips=[other];
    mocks.media.tracks=[{audioSourceId:target.audioSourceId,sourceStream:0,sourceChannel:0,buffer:pcm(.2)},
      {audioSourceId:target.audioSourceId,sourceStream:1,sourceChannel:0,buffer:pcm(.6)},
      {audioSourceId:other.audioSourceId,sourceStream:0,sourceChannel:0,buffer:pcm(.95)}];
    if(entry==='toolbar'){setSelection({kind:'audio',ids:[target.id]});await open();}
    else if(entry==='preferred')await open({...target});
    else{await open(other);element('asrClipSelect').value=target.id;element('asrClipSelect').dispatchEvent(new Event('change',{bubbles:true}));}
    expect([...element('asrRecognitionAudioSource').options].map(option=>option.value)).toEqual(['all','channel-1','channel-2']);
    await start();expect(mocks.transcribe).toHaveBeenCalledOnce();
    expect(mocks.transcribe.mock.calls[0][0].audioBuffer.getChannelData(0)[0]).toBeCloseTo(.4);
  });

  it('視窗開啟後才就緒的快取，在開始時由來源 owner 接受',async()=>{
    saveAsrConfig({...getAsrConfig(),provider:'builtin'});
    const target=source('late',{preferCache:true});State.externalAudioState=[target];await open(target);
    mocks.media.tracks=[{audioSourceId:target.audioSourceId,sourceStream:0,sourceChannel:0,buffer:pcm(.7)}];
    await start();expect(mocks.transcribe).toHaveBeenCalledOnce();
    expect(mocks.transcribe.mock.calls[0][0].audioBuffer.getChannelData(0)[0]).toBeCloseTo(.7);
  });

  it.each(['preferred','selector'])('%s 在開始前 metadata completion 延長來源時接受最新範圍',async entry=>{
    saveAsrConfig({...getAsrConfig(),provider:'builtin'});
    const buffer={sampleRate:16000,numberOfChannels:1,length:32000,duration:2,getChannelData:()=>new Float32Array(32000).fill(.4)};
    const target=source('duration',{audioBuffer:buffer,in:0,out:1,dur:1,duration:1,vtrack:0});
    const other=source('other',{audioBuffer:pcm(.2),vtrack:1});State.clips=[target,other];
    await open(entry==='selector'?other:target);
    if(entry==='selector'){element('asrClipSelect').value=target.id;element('asrClipSelect').dispatchEvent(new Event('change',{bubbles:true}));}
    Seq.updateSourceDur(target,2);expect(target.out).toBe(2);
    await start();expect(mocks.transcribe).toHaveBeenCalledOnce();expect(mocks.transcribe.mock.calls[0][0].outT).toBe(2);
  });

  it('已接受多來源工作不跟著後續播放器清除或替換改讀另一份聲音',async()=>{
    saveAsrConfig({...getAsrConfig(),provider:'builtin'});
    const first=source('first',{audioBuffer:pcm(.2),vtrack:0}),second=source('second',{preferCache:true,dur:1,duration:1,out:1,vtrack:1});
    State.clips=[first,second];
    const playback={src:'blob:accepted-audio'};
    mocks.media.tracks=[{audioSourceId:second.audioSourceId,sourceStream:0,sourceChannel:0,el:playback}];
    const fetchAudio=vi.fn(async()=>({ok:true,arrayBuffer:async()=>new ArrayBuffer(4)}));vi.stubGlobal('fetch',fetchAudio);
    mocks.decode.mockResolvedValue(pcm(.6));
    let finishFirst;mocks.transcribe.mockImplementationOnce(()=>new Promise(resolve=>{finishFirst=resolve;}));
    await open([first,second]);const pending=start();
    await vi.waitFor(()=>expect(finishFirst).toBeTypeOf('function'));
    playback.src='blob:replacement-audio';mocks.media.tracks=[];Seq.updateSourceDur(second,2);expect(second.out).toBe(2);
    finishFirst([]);await pending;
    expect(fetchAudio).toHaveBeenCalledWith('blob:accepted-audio',expect.objectContaining({signal:expect.any(AbortSignal)}));
    expect(mocks.transcribe).toHaveBeenCalledTimes(2);
    expect(mocks.transcribe.mock.calls[1][0]).toMatchObject({inT:0,outT:1});
    expect(mocks.transcribe.mock.calls[1][0].audioBuffer.getChannelData(0)[0]).toBeCloseTo(.6);
  });
});
