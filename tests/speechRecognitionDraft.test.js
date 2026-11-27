// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks=vi.hoisted(()=>({
  media:{tracks:[]},transcribe:vi.fn(),decode:vi.fn(),open:vi.fn(),close:vi.fn(),toast:vi.fn(),
}));
vi.mock('../src/media.js',()=>({Media:mocks.media}));
vi.mock('../src/project.js',()=>({Project:{captureWorkspaceOwnership:()=>()=>true,onWorkspaceInvalidated:()=>()=>{}}}));
vi.mock('../src/events.js',()=>({emit:vi.fn(),on:vi.fn()}));
vi.mock('../src/history.js',()=>({recordHistory:vi.fn()}));
vi.mock('../src/ui.js',()=>({renderCurrentTimecode:vi.fn(),openModal:mocks.open,closeModal:mocks.close,showToast:mocks.toast}));
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
  mocks.open.mockImplementation((_title,html)=>{
    document.body.innerHTML=html+'<div id="modalFoot"></div>';
    return {isCurrent:()=>true,close:mocks.close};
  });
  State.clips=[];State.externalAudioState=[];State.cues=[];State.tracks=[{name:'字幕',locked:false}];
  setSelection();
  saveAsrConfig({...getAsrConfig(),provider:'google',googleApiKey:'saved-google',prompt:'已保存提示'});
});
afterEach(()=>{clearAsrSession();vi.unstubAllGlobals();});

describe('辨識設定草稿由同一 live dialog 保留',()=>{
  it('只重跑一則附近的音訊，選取建議前後均保留其他候選的人工修訂',async()=>{
    const target=source('rerun',{duration:40,out:40,audioBuffer:{...pcm(.2),duration:40}});
    State.clips=[target];State.fps=25;
    mocks.transcribe.mockResolvedValueOnce([{start:4,end:5,text:'一'},{start:20,end:21,text:'二'}])
      .mockResolvedValueOnce([{start:2,end:3,text:'二號'}]);
    await open(target);element('asrResultMode').value='review';await start();
    element('recognitionReviewText').value='人工一';element('recognitionReviewText').dispatchEvent(new Event('input'));
    element('recognitionReviewNext').click();element('recognitionReviewRerun').click();
    await vi.waitFor(()=>expect(element('recognitionReviewSuggestedText').textContent).toBe('二號'));
    expect(mocks.transcribe.mock.lastCall[0]).toMatchObject({inT:18,outT:23});
    expect(element('recognitionReviewText').value).toBe('二');
    element('recognitionReviewUseSuggestion').click();await start();
    expect(State.cues.map(cue=>[cue.text,cue.start,cue.end])).toEqual([['人工一',4,5],['二號',20,21]]);
    expect(State.cues.map(cue=>cue.recognition.originalText)).toEqual(['一','二']);
  });
  it('舊金鑰確認可解密後才移除，等待期間連按兩次只開始一次工作', async () => {
    const target=source('migration',{audioBuffer:pcm(.4)}); State.clips=[target];
    let confirm;
    const saved=new Promise(resolve=>{confirm=resolve;});
    window.subtool={speechKeyStatus:async()=>({openai:false}),saveSpeechKeys:vi.fn(()=>saved)};
    const old={provider:'openai',openaiApiKey:'synthetic-old',speechLanguage:'en'};
    localStorage.setItem('subtool_asr_config',JSON.stringify(old));
    try {
      await open(target);
      expect(element('asrApiKey').value).toBe('');
      expect(window.subtool.saveSpeechKeys).toHaveBeenCalledWith({openai:'synthetic-old'});
      const first=start(), second=start();
      expect(JSON.parse(localStorage.getItem('subtool_asr_config'))).toEqual(old);
      confirm({openai:true});
      await Promise.all([first,second]);
      expect(mocks.transcribe).toHaveBeenCalledOnce();
      expect(mocks.transcribe.mock.calls[0][0].apiKey).toBe('subtool-saved-credential-openai');
      expect(localStorage.getItem('subtool_asr_config')).not.toContain('synthetic-old');
    } finally {delete window.subtool;}
  });
  it('OpenAI 供應商時間在服務截止前仍可用，截止日起明示本機模型、開窗不會下載或辨識',async()=>{
    const date=vi.spyOn(Date,'now');
    const target=source('cutoff',{audioBuffer:pcm(.4)});State.clips=[target];
    try{
      saveAsrConfig({...getAsrConfig(),provider:'openai',openaiTiming:'provider'});
      date.mockReturnValue(Date.UTC(2027,1,26)-1);await open(target);
      expect(element('asrOpenAiTiming').value).toBe('provider');
      expect(element('asrOpenAiTiming').options[0].disabled).toBe(false);
      date.mockReturnValue(Date.UTC(2027,1,26));await open(target);
      expect(element('asrOpenAiTiming').value).toBe('local');expect(getAsrConfig().openaiTiming).toBe('local');
      expect(element('asrOpenAiTiming').options[0].disabled).toBe(true);
      expect(element('asrOpenAiTimingField').textContent).toContain('首次使用會下載 Whisper');
      expect(mocks.transcribe).not.toHaveBeenCalled();
    }finally{date.mockRestore();}
  });
  it('桌面已存金鑰試跑傳送播放點附近 20 秒及詞表，候選修改後才寫入，保留原文和無時間的聽寫',async()=>{
    window.subtool={speechKeyStatus:async()=>({openai:true})};
    const previousTerms=State.recognitionTerms;
    State.recognitionTerms=['舊詞'];mocks.media.displayTime=()=>12;
    const target=source('trial',{out:50,duration:50,audioBuffer:{...pcm(.2),duration:50}});
    State.clips=[target];mocks.transcribe.mockResolvedValue([{start:0,end:0,timed:false,text:'原文'}]);
    try{
      await open(target);switchProvider('openai');element('asrApiKey').value='';
      element('asrOpenAiTiming').value='local';element('asrProjectTerms').value='李華\n李華';element('asrResultMode').value='trial';
      await start();
      expect(mocks.transcribe.mock.lastCall[0]).toMatchObject({inT:12,outT:32,apiKey:'subtool-saved-credential-openai',projectTerms:['李華'],openaiTiming:'local'});
      expect(State.cues).toEqual([]);expect(State.tracks).toHaveLength(1);expect(State.recognitionTerms).toEqual(['舊詞']);
      element('recognitionReviewText').value='人工改字';element('recognitionReviewText').dispatchEvent(new Event('input'));
      await start();
      expect(State.cues).toMatchObject([{timed:false,text:'人工改字',recognition:{originalText:'原文',timingEvidence:'none',kind:'speech'}}]);
      await open(target);expect(element('asrOpenAiTiming').value).toBe('local');
    }finally{delete window.subtool;delete mocks.media.displayTime;State.recognitionTerms=previousTerms;}
  });
  it('往返引擎與模式保留各自的 API Key，開始時使用目前引擎的金鑰', async () => {
    const target = source('draft', {audioBuffer:pcm(.4)});
    State.clips = [target];
    await open(target);
    element('asrApiKey').value = 'draft-google';
    switchProvider('azure');
    element('asrApiKey').value = 'eastasia:draft-azure';
    element('asrModeAlign').click();
    element('asrTranscript').value = '原稿';
    switchProvider('builtin');
    switchProvider('google');
    expect(element('asrApiKey').value).toBe('draft-google');
    switchProvider('azure');
    expect(element('asrApiKey').value).toBe('eastasia:draft-azure');
    await start();
    expect(mocks.transcribe.mock.calls[0][0]).toMatchObject({provider:'azure', taskMode:'align',
      apiKey:'draft-azure', azureRegion:'eastasia'});
  });

  it.each(['cancel','replacement'])('%s 放棄本次草稿，不污染已保存設定或重開視窗',async reason=>{
    const target=source('cancel',{audioBuffer:pcm(.4)});State.clips=[target];const before=getAsrConfig();
    const call=await open(target);element('asrApiKey').value='private-unsaved';
    element('asrLanguage').value='ja';
    switchProvider('azure');element('asrApiKey').value='private-azure';switchProvider('google');
    if(reason==='cancel')call[2][0].act();else call[3].onReplaced();
    expect(getAsrConfig()).toEqual(before);await open(target);
    expect(element('asrApiKey').value).toBe('saved-google');
    expect(element('asrLanguage').value).toBe('auto');
    expect(mocks.transcribe).not.toHaveBeenCalled();
  });
});

describe('語音辨識與文本匹配的引擎設定', () => {
  const legacy = {
    vocalFilter:true, elevenlabsKeyterms:'舊專名甲，舊專名乙', elevenlabsNumSpeakers:'3',
    elevenlabsTagAudioEvents:true, azurePhraseList:'限 Azure', elevenlabsApiKey:'saved-eleven',
    builtinModel:'onnx-community/whisper-tiny', prompt:'僅文本匹配', azureProfanity:'Masked', temperature:.8
  };
  beforeEach(() => {
    saveAsrConfig({...getAsrConfig(), ...legacy, provider:'elevenlabs', taskMode:'align'});
  });

  const providers = ['builtin', 'groq', 'openai', 'azure', 'google', 'elevenlabs'];
  it.each(providers.flatMap(provider => ['align', 'transcribe'].map(mode => [provider, mode])))('%s 的 %s 只送出必要參數', async (provider, taskMode) => {
    const target = source('original', {audioBuffer:pcm(.4)});
    State.clips = [target];
    await open(target);
    switchProvider(provider);
    if (provider !== 'builtin') element('asrApiKey').value = 'saved-key';
    element(taskMode === 'align' ? 'asrModeAlign' : 'asrModeTranscribe').click();
    element('asrTranscript').value = '原稿';
    const visibleControls = [...document.querySelectorAll('.asr-engine-card .asr-field')]
      .filter(row => getComputedStyle(row).display !== 'none').map(row => row.querySelector('input, select')?.id);
    expect(visibleControls).toEqual(provider === 'builtin' ? ['asrProvider', 'asrLanguage']
      : ['asrProvider', 'asrApiKey', 'asrLanguage']);
    await start();
    expect(mocks.transcribe).toHaveBeenCalledOnce();
    const [request] = mocks.transcribe.mock.calls[0];
    expect(request).toMatchObject({provider, taskMode, language:'auto'});
    for (const key of ['builtinModel', 'azureProfanity', 'azurePhrases', 'prompt', 'keyterms',
      'elevenlabsNumSpeakers', 'elevenlabsTagAudioEvents', 'vocalFilter', 'temperature']) {
      expect(request).not.toHaveProperty(key);
    }
    if (provider === 'builtin') expect(request).not.toHaveProperty('apiKey');
    expect(getAsrConfig()).not.toHaveProperty('elevenlabsKeyterms');
  });

  it.each([
    ['transcribe', 'zh', 'auto', 'auto'], ['transcribe', 'ko', 'ko', 'auto'],
    ['align', 'ja', 'auto', 'ja'], ['align', 'zh', 'auto', 'auto'], ['align', 'unsupported', 'auto', 'auto']
  ])('舊 %s 偏好 %s 遷移後語音與匹配各自記住合法語言', async (oldMode, oldLanguage, speechLanguage, alignmentLanguage) => {
    saveAsrConfig({provider:'google', googleApiKey:'test', taskMode:oldMode, language:oldLanguage});
    const target = source('language', {audioBuffer:pcm(.4)});
    State.clips = [target];
    await open(target);
    element('asrModeTranscribe').click();
    expect(element('asrLanguage').value).toBe(speechLanguage);
    element('asrLanguage').value = 'zh';
    switchProvider('builtin');
    expect(element('asrLanguage').value).toBe('zh');
    element('asrModeAlign').click();
    expect(element('asrLanguage').value).toBe(alignmentLanguage);
    element('asrModeTranscribe').click();
    await start();
    expect(mocks.transcribe.mock.calls[0][0].language).toBe('zh');
    expect(getAsrConfig()).toMatchObject({speechLanguage:'zh', alignmentLanguage});
    clearAsrSession();
    await open(target);
    expect(element('asrLanguage').value).toBe('zh');
  });

  it.each([
    ['known-key', 'eastasia', 'known-key', 'eastasia'], ['changed-key', 'eastasia', 'changed-key', 'japaneast'],
    ['westus:new-key', 'eastasia', 'new-key', 'westus'], ['known-key', 'invalid-region', 'known-key', 'japaneast']
  ])('Azure 語音用單一欄位 %s 獲得正確金鑰與區域', async (entered, savedRegion, key, region) => {
    saveAsrConfig({...getAsrConfig(), taskMode:'transcribe', provider:'azure', azureApiKey:'known-key', azureRegion:savedRegion});
    const target = source('azure', {audioBuffer:pcm(.4)});
    State.clips = [target];
    await open(target);
    expect(element('asrAzureRegion')).toBeNull();
    element('asrApiKey').value = entered;
    await start();
    expect(mocks.transcribe.mock.calls[0][0]).toMatchObject({provider:'azure', apiKey:key, azureRegion:region});
    expect(getAsrConfig()).toMatchObject({azureApiKey:key, azureRegion:region});
  });

  it('兩種模式的 ElevenLabs API 表單皆使用自動設定並保留字幕時間', async () => {
    const engine = await vi.importActual('../src/speech-recognition-engine.js');
    mocks.transcribe.mockImplementation(engine.transcribeAudioStream);
    const fetch = vi.fn().mockResolvedValue({ok:true, json:async () => ({
      text:'原稿', words:[{type:'word', text:'原稿', start:.25, end:.75, speaker_id:'speaker_0'}]
    })});
    vi.stubGlobal('fetch', fetch);
    const target = source('modes', {out:1, duration:1, audioBuffer:{
      duration:1, numberOfChannels:1, length:16000, sampleRate:16000, getChannelData:() => new Float32Array(16000).fill(.4)
    }});
    State.fps = 24;
    State.clips = [target];
    await open(target);
    element('asrTranscript').value = '原稿';
    await start();
    expect(fetch).toHaveBeenCalledOnce();
    const matched = fetch.mock.calls[0][1].body;
    expect(matched.get('model_id')).toBe('scribe_v3');
    expect(matched.getAll('keyterms')).toEqual([]);
    expect(matched.has('num_speakers')).toBe(false);
    expect(matched.get('tag_audio_events')).toBe('false');
    expect(mocks.transcribe.mock.calls[0][0]).not.toHaveProperty('vocalFilter');
    expect(State.cues.at(-1)).toMatchObject({text:'原稿', start:.25, end:.75});

    clearAsrSession();
    await open(target);
    element('asrModeTranscribe').click();
    await start();
    expect(fetch).toHaveBeenCalledTimes(2);
    const speech = fetch.mock.calls[1][1].body;
    expect(speech.get('model_id')).toBe('scribe_v3');
    expect(speech.get('diarize')).toBe('true');
    expect(speech.getAll('keyterms')).toEqual([]);
    expect(speech.has('num_speakers')).toBe(false);
    expect(speech.get('tag_audio_events')).toBe('false');
    expect(State.cues.at(-1)).toMatchObject({text:'原稿', start:.25, end:.75});
  });
});

describe('語音辨識的全片與輸出 In／Out 範圍', () => {
  const chooseRange = mode => {
    const select = element('asrRecognitionRange');
    select.value = mode;
    select.dispatchEvent(new Event('change'));
  };
  beforeEach(() => {
    State.fps = 25; State.exportIn = null; State.exportOut = null;
    saveAsrConfig({...getAsrConfig(), provider:'builtin'});
  });
  it.each(['all', 'export'])('%s 擷取影片與反向外音的母素材秒數，凍結來源與每條可聽聲道', async mode => {
    const video = source('video', { in:2, out:8, offset:4, duration:12, speed:2 });
    const audio = source('external', { in:2, out:10, offset:9, duration:12, speed:2, reverse:true });
    State.clips = [video, {...video, id:'still', type:'image'}, {...video, id:'freeze', freezeTime:2},
      {...video, id:'detached', audioDetached:true}];
    State.externalAudioState = [audio, {...audio, id:'off', audioSourceId:'off', enabled:false}];
    State.exportIn = 5; State.exportOut = 11.02;
    const input = value => ({ ...pcm(value), duration:12, length:192000,
      getChannelData:() => new Float32Array(192000).fill(value) });
    mocks.media.tracks = [
      {audioSourceId:video.audioSourceId, sourceStream:0, sourceChannel:0, buffer:input(.1), muted:true},
      {audioSourceId:video.audioSourceId, sourceStream:0, sourceChannel:1, buffer:input(.2)},
      {audioSourceId:audio.audioSourceId, sourceStream:0, sourceChannel:0, buffer:input(.7)}
    ];
    let finishFirst;
    mocks.transcribe.mockImplementationOnce(() => new Promise(resolve => { finishFirst = resolve; }))
      .mockResolvedValueOnce([{start:-9,end:30,text:'外音'}, {start:20,end:25,text:'範圍外'}]);
    await open(video); chooseRange(mode);
    expect(element('asrSourceTitle').textContent).toContain('2 個');
    const pending = start();
    await vi.waitFor(() => expect(finishFirst).toBeTypeOf('function'));
    State.exportOut = 6; audio.offset = 100; audio.reverse = false; State.fps = 24;
    mocks.media.tracks = [];
    finishFirst([{start:0,end:2,text:'影片'}]); await pending;
    const [first, second] = mocks.transcribe.mock.calls.map(([options]) => options);
    expect(first.inT).toBe(mode === 'all' ? 2 : 4); expect(first.outT).toBe(8);
    expect(first.audioBuffer.getChannelData(0)[0]).toBeCloseTo(.2);
    expect(second.inT).toBeCloseTo(mode === 'all' ? 2 : 5.96); expect(second.outT).toBe(10);
    expect(second.audioBuffer.getChannelData(0)[0]).toBeCloseTo(.7);
    expect(State.cues).toEqual([]);
    expect(element('recognitionReviewMoved').hidden).toBe(false);
    element('recognitionReviewPosition').value='original';
    mocks.open.mock.calls.at(-1)[2].find(button=>button.primary).act();
    const startTime = mode === 'all' ? 4 : 5;
    expect(State.cues.map(({start,end,text}) => [start,end,text])).toEqual([
      [startTime, startTime + 1, '影片'], [9, mode === 'all' ? 13 : 11, '外音']
    ]);
  });
  it('範圍無交集時保留表單，未建立推論工作', async () => {
    const clip = source('outside', { in:0, out:2, offset:10 });
    State.clips = [clip]; State.exportIn = 4; State.exportOut = 6;
    await open(clip); chooseRange('export'); await start();
    expect(element('asrStatus').textContent).toMatch(/沒有可辨識的音訊/);
    expect(mocks.transcribe).not.toHaveBeenCalled();
  });
  it('全片只辨識專案 Solo 聲道，並遵守其 bus 開關', async () => {
    const saved = State.audioProject;
    const video = source('video', {preferCache:true}), other = source('other', {audioBuffer:pcm(.1)});
    State.clips = [video,other];
    State.audioProject = { buses:[{id:'active'}, {id:'muted', muted:true}], sourceMaps:{
      [video.audioSourceId]:{ channels:[
        {sourceStream:0,sourceChannel:0,busIds:['active']},
        {sourceStream:0,sourceChannel:1,busIds:['muted']}
      ] }
    } };
    mocks.media.tracks = [
      {audioSourceId:video.audioSourceId, sourceStream:0, sourceChannel:0, solo:true, buffer:pcm(.8)},
      {audioSourceId:video.audioSourceId, sourceStream:0, sourceChannel:1, solo:true, buffer:pcm(.2)}
    ];
    try {
      await open(other); chooseRange('all'); await start();
      expect(mocks.transcribe).toHaveBeenCalledTimes(1);
      expect(mocks.transcribe.mock.calls[0][0].audioBuffer.getChannelData(0)[0]).toBeCloseTo(.8);
    } finally { State.audioProject = saved; }
  });
  it('用母檔探測及讀取原音，跳過沒有音訊串流的影片', async () => {
    const video = source('spoken', { path:'C:/proxy.mkv', _originalPath:'C:/master.mov', duration:2, in:.25, out:.5 });
    const silent = source('silent', { path:'C:/silent.mov', duration:.5, in:0, out:.5 });
    State.clips = [silent,video];
    const probe = vi.fn(async path => ({ audio:path === video._originalPath ? [{channels:2},{channels:1}] : [] }));
    const speechAudioRead = vi.fn(async ({sourceStream,duration}) => {
      const samples = new Float32Array(Math.round(duration * 16000)).fill(sourceStream ? .7 : .1);
      return {frames:samples.length, sampleRate:16000, numberOfChannels:1, pcm:samples.buffer};
    });
    window.subtool = { probe, speechAudioRead, speechAudioCancel:vi.fn() };
    try {
      let observed;
      mocks.transcribe.mockImplementation(async ({audioBuffer,inT,outT}) => {
        observed = await audioBuffer.readRange(inT,outT); return [];
      });
      await open(video); chooseRange('all'); await start();
      expect(probe.mock.calls.map(([path])=>path)).toEqual([silent.path,video._originalPath]);
      expect(mocks.transcribe).toHaveBeenCalledTimes(1);
      expect(speechAudioRead.mock.calls.map(([request])=>[request.path,request.start,request.duration,request.sourceStream]))
        .toEqual([[video._originalPath,.25,.25,0],[video._originalPath,.25,.25,1]]);
      expect(observed.getChannelData(0)[0]).toBeCloseTo(.3);
    } finally { delete window.subtool; }
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
