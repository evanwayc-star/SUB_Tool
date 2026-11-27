import { $ } from './dom.js';
import { openModal, showToast } from './ui.js';
import { escapeHTML } from './util.js';
import { State } from './state.js';
import { secToEncore } from './time.js';
import { getScreenTextPlan, screenTextTrialPlan } from './screen-text-recognition.js';
import { openRecognitionReview } from './recognition-review.js';
import { combineScreenTextMetrics, screenTextPlanLabel, screenTextUsageLabel } from './screen-text-usage.js';
import {
  cancelScreenTextSession, clearScreenTextSession, getScreenTextSession, onScreenTextSessionChange,
  resolveScreenTextPartial, setScreenTextDialogOpen, startScreenTextSession,
} from './screen-text-session.js';
import { SCREEN_TEXT_MODELS as modelOptions, SCREEN_TEXT_DEFAULT_MODELS as defaultModels,
  SCREEN_TEXT_DEFAULTS } from '../shared/screen-text-options.cjs';
const languageNames = { auto:'自動判斷', ko:'韓文', ja:'日文', zh:'中文', en:'英文' };
const customModelOption = '__custom__';
const defaults = { ...SCREEN_TEXT_DEFAULTS, scope:'clip' };


function isActive(job) {
  return job?.status === 'running' || job?.status === 'cancelling';
}

function needsMonitor(job) {
  return isActive(job) || job?.status === 'partial';
}

let monitorModal;
let retrySource;
let pendingPreviewExit;

function rememberSource(job, source) {
  retrySource = { ...source, id:job.id };
  const unsubscribe = onScreenTextSessionChange(snapshot => {
    if (isActive(snapshot) && snapshot.id === job.id) return;
    if (retrySource?.id === job.id) retrySource = null;
    unsubscribe();
  });
}

export function openScreenTextRecognitionDialog(clip, ownsClip, ownsWorkspace = ownsClip) {
  if(openRecognitionReview('screen')) return;
  if (needsMonitor(getScreenTextSession())) {
    openScreenTextMonitorDialog();
    return;
  }
  openSettings({ clip, ownsClip, ownsWorkspace }, defaults);
}

function rangeLabel({start, end}, fps, dropFrame) {
  return `In ${secToEncore(start, fps, dropFrame)}　Out ${secToEncore(end, fps, dropFrame)}`;
}

function openSettings(source, settings, failure = '') {
  const { clip, ownsClip, ownsWorkspace } = source;
  const sourceChanged = scope => {
    if (scope === 'clip' && !ownsClip()) return '影片片段已變更，請重新開啟辨識畫面文字。';
    if (!ownsWorkspace()) return '專案已變更，請重新開啟辨識畫面文字。';
    return '';
  };
  const changed = sourceChanged(settings.scope);
  if (changed) { showToast(changed); return; }
  let loading = true, starting = false, hasApiKey = {};

  const session = openModal('辨識畫面文字', `
    <div class="asr-workspace ocr-settings-layout">
      <div class="asr-field">
        <label for="ocrScope">辨識範圍</label>
        <select id="ocrScope" aria-describedby="ocrScopeSummary ocrScopeDefault ocrScopeError">
          <option value="clip">目前片段</option>
          <option value="all">整個時間軸（全片）</option>
          <option value="export">輸出 In／Out 範圍</option>
        </select>
        <div id="ocrScopeSummary" class="asr-helper" role="status">
          <strong id="ocrScopeSource"></strong><span id="ocrScopeRange"></span>
        </div>
        <p id="ocrScopeDefault" class="asr-helper" hidden></p>
        <p id="ocrScopeError" class="asr-field-error" role="alert" hidden></p>
      </div>
      <div class="asr-field ocr-setting-half">
        <label for="ocrSourceLang">畫面語言</label>
        <select id="ocrSourceLang">${Object.entries(languageNames).map(([code, name]) => `<option value="${code}">${name}</option>`).join('')}</select>
      </div>
      <div class="asr-field ocr-setting-half">
        <label for="ocrProvider">雲端供應商</label>
        <select id="ocrProvider"><option value="openai">OpenAI</option><option value="gemini">Google Gemini</option></select>
      </div>
      <div class="asr-field">
        <label for="ocrModel">視覺模型（初掃）</label>
        <select id="ocrModel" required></select>
      </div>
      <div id="ocrCustomModelField" class="asr-field" hidden>
        <label for="ocrCustomModel">自訂模型名稱</label>
        <input id="ocrCustomModel" type="text" maxlength="128" autocomplete="off" spellcheck="false" placeholder="輸入供應商提供的模型 ID">
      </div>
      <div class="asr-field">
        <label for="ocrApiKey">API 金鑰</label>
        <input id="ocrApiKey" type="password" autocomplete="off" spellcheck="false" aria-describedby="ocrKeyStatus">
        <p id="ocrKeyStatus" class="asr-helper" role="status">正在讀取設定…</p>
      </div>
      <div class="asr-field ocr-setting-half">
        <label for="ocrSampleFps">每秒取樣張數</label>
        <input id="ocrSampleFps" type="number" min="0.1" max="10" step="any" required value="${settings.sampleFps}">
      </div>
      <div class="asr-field ocr-setting-half">
        <label for="ocrFrameWidth">送出畫面寬度</label>
        <select id="ocrFrameWidth"><option value="960">960 px</option><option value="1024">1024 px</option><option value="1280">1280 px</option><option value="1440">1440 px</option><option value="1920">1920 px（最高，不放大原片）</option></select>
      </div>
      <label class="asr-checkbox-label"><input id="ocrSmartAccuracy" type="checkbox">智慧精準辨識：補查變化畫面與短字卡</label>
      <div class="asr-field"><label for="ocrContentMode">內容模式</label><select id="ocrContentMode"><option value="faithful">忠實抄錄原文</option><option value="variety">綜藝動態字卡</option></select></div>
      <div class="asr-field"><label for="ocrResultMode">結果處理</label><select id="ocrResultMode"><option value="apply">直接加入新字幕軌</option><option value="review">先複核，再加入新軌</option><option value="trial">辨識播放點附近 20 秒，先看候選</option></select></div>
      <details class="asr-inline-details"><summary>畫面範圍、預覽與用量</summary>
        <label><input type="checkbox" id="ocrUseRegion">只辨識指定區域</label>
        <div id="ocrRegionFields" class="ocr-region-fields" hidden>${['左','上','寬','高'].map((name,i)=>`<label>${name} %<input type="number" id="ocrRegion${i}" min="0" max="100" step="0.1" value="${i>1?100:0}"></label>`).join('')}</div>
        <label for="ocrBudget">本次最多新增的雲端請求</label><input id="ocrBudget" type="number" min="0" step="1" placeholder="不限制；輸入 0 只用快取">
        <button type="button" id="ocrPlan" class="asr-compact-button">本機預覽與取樣估計</button>
        <button type="button" id="ocrCropFrame" class="asr-compact-button">在原畫面框選</button>
        <p id="ocrPlanInfo" class="asr-helper" role="status"></p><div class="ocr-region-frame" id="ocrPreviewFrame" hidden>
        <img id="ocrPreviewImage" draggable="false" alt="來源實際取樣畫格"><div id="ocrRegionRect" hidden></div></div>
      </details>
      <p id="ocrAccuracyHelp" class="asr-helper"></p>
      <p class="asr-helper">取樣畫面會傳送至選定的雲端供應商，API 按量計費。金鑰以系統加密儲存在本機。</p>
      <p class="asr-helper">字卡與畫面中的對白字幕分別加入「畫面字卡」及「畫面對白」軌，可再匯出 SRT。</p>
      <p id="ocrError" class="asr-field-error" role="alert"${failure ? '' : ' hidden'}>${escapeHTML(failure)}</p>
    </div>`, [
    { label: '取消', id: 'ocrCancel', act: () => session.close() },
    { label: '開始辨識', id: 'ocrStart', primary: true, act: start },
  ], { width: '640px', closeOnBackdrop: false,
    onDismiss:()=>{clearKey();cancelPlan();}, onReplaced:()=>{clearKey();cancelPlan();} });

  const rate = $('ocrSampleFps'), provider = $('ocrProvider'), model = $('ocrModel');
  const customModel = $('ocrCustomModel'), customModelField = $('ocrCustomModelField');
  const language = $('ocrSourceLang'), width = $('ocrFrameWidth'), smart = $('ocrSmartAccuracy'), apiKey = $('ocrApiKey');
  const scope = $('ocrScope');
  const error = $('ocrError');
  const modelDrafts = {};
  let planning=null,drawOnImage=false;
  const useRegion=$('ocrUseRegion'),regionFields=$('ocrRegionFields'),regionInputs=[0,1,2,3].map(index=>$('ocrRegion'+index));
  const updateRegion=()=>{regionFields.hidden=!useRegion.checked;$('ocrRegionRect').hidden=!drawOnImage||!useRegion.checked;};
  function setRegion(rect){
    useRegion.checked=!!rect;
    const values=rect?[rect.x,rect.y,rect.width,rect.height]:[0,0,1,1];
    values.forEach((value,i)=>regionInputs[i].value=String(Math.round(value*1000)/10));
    updateRegion();draw();
  }
  function getRegion(){
    if(!useRegion.checked)return undefined;
    const [x,y,width,height]=regionInputs.map(input=>input.valueAsNumber/100);
    if(![x,y,width,height].every(Number.isFinite)||x<0||y<0||width<=0||height<=0||x+width>1.000001||y+height>1.000001)
      throw new Error('辨識區域的寬高須大於零，且四邊都在畫面內。');
    return {x,y,width:Math.min(1-x,width),height:Math.min(1-y,height)};
  }
  function draw(){
    const rect=$('ocrRegionRect');if(!rect)return;
    const [x,y,w,h]=regionInputs.map(input=>input.valueAsNumber);
    Object.assign(rect.style,{left:x+'%',top:y+'%',width:w+'%',height:h+'%'});
  }
  function cancelPlan(){
    const work=planning;planning=null;
    if(work?.id)void window.subtool.cancelScreenText?.(work.id).catch(()=>{});
    return pendingPreviewExit;
  }
  function invalidatePreview(){
    cancelPlan();drawOnImage=false;$('ocrPreviewFrame').hidden=true;$('ocrPlanInfo').textContent='';
  }
  const ocrRequest=()=>({provider:provider.value,model:model.value===customModelOption?customModel.value.trim():model.value,
    sourceLang:language.value,samplesPerSecond:rate.valueAsNumber,frameWidth:Number(width.value),smartAccuracy:smart.checked,
    contentMode:$('ocrContentMode').value});
  async function preview(drawRegion){
    if(loading||starting)return;
    const previous=cancelPlan(),info=$('ocrPlanInfo');
    if(!window.subtool.planScreenText){info.textContent='目前的桌面版本無法提供本機預覽。';return;}
    const work={};planning=work;info.textContent='正在本機擷取與計算…';
    try{
      if(previous)await previous;
      if(planning!==work||!session.isCurrent()||!ownsWorkspace())return;
      const plan=$('ocrResultMode').value==='trial'?screenTextTrialPlan(clip,scope.value):getScreenTextPlan(clip,scope.value);
      const region=drawRegion?undefined:getRegion();const totals={};
      let previewImage=null,previewTime=null;
      for(const item of (drawRegion?plan.windows.slice(0,1):plan.windows)){
        work.id=crypto.randomUUID();
        const responsePromise=window.subtool.planScreenText({requestId:work.id,path:item.path,start:item.start,end:item.end,...ocrRequest(),...(region?{region}:{})});
        const exited=responsePromise.then(()=>{},()=>{});
        pendingPreviewExit=exited;
        let response;
        try{response=await responsePromise;}finally{if(pendingPreviewExit===exited)pendingPreviewExit=null;}
        if(planning!==work||!session.isCurrent()||!ownsWorkspace())return;
        Object.assign(totals,combineScreenTextMetrics(totals,response.metrics));
        if(!previewImage&&response.previewJpeg){previewImage=response.previewJpeg;previewTime=response.previewTime;}
      }
      drawOnImage=drawRegion;
      $('ocrPreviewFrame').hidden=!previewImage;
      if(previewImage)$('ocrPreviewImage').src='data:image/jpeg;base64,'+previewImage;
      info.textContent=(drawRegion?'在畫面上拖曳，或輸入左、上、寬、高百分比。':screenTextPlanLabel(totals)+'。尚未送雲端，實際費用依供應商計費。')
        +(Number.isFinite(previewTime)?' 來源 '+previewTime.toFixed(2)+' 秒':'');
      updateRegion();draw();
    }catch(e){if(planning===work&&session.isCurrent())info.textContent=e.message;}
    finally{if(planning===work)planning=null;}
  }
  $('ocrPlan').onclick=()=>preview(false);$('ocrCropFrame').onclick=()=>preview(true);
  useRegion.onchange=()=>{cancelPlan();updateRegion();draw();};regionInputs.forEach(input=>input.oninput=()=>{cancelPlan();draw();});
  const img=$('ocrPreviewImage');
  let press;
  const point=event=>{const r=img.getBoundingClientRect();return [Math.max(0,Math.min(1,(event.clientX-r.left)/r.width)),Math.max(0,Math.min(1,(event.clientY-r.top)/r.height))];};
  img.onpointerdown=e=>{if(!drawOnImage)return;e.preventDefault();press=point(e);img.setPointerCapture?.(e.pointerId);};
  img.onpointerup=e=>{
    if(!press)return;const [x,y]=point(e),[sx,sy]=press;press=null;
    if(Math.abs(x-sx)<.01||Math.abs(y-sy)<.01)return;
    setRegion({x:Math.min(x,sx),y:Math.min(y,sy),width:Math.abs(x-sx),height:Math.abs(y-sy)});
  };
  img.onpointercancel=()=>{press=null;};
  let activeProvider;
  function clearKey() { apiKey.value = ''; }
  function updateCustomModel() {
    const custom = model.value === customModelOption;
    customModelField.hidden = !custom;
    customModel.required = custom;
    customModel.disabled = loading || starting || !custom;
    customModel.setCustomValidity('');
  }
  function renderModels(draft) {
    model.innerHTML = modelOptions[provider.value].map(name =>
      `<option value="${name}">${name}${name === defaultModels[provider.value] ? '（預設）' : ''}</option>`).join('')
      + `<option value="${customModelOption}">自訂模型…</option>`;
    model.value = draft?.model ?? defaultModels[provider.value];
    customModel.value = draft?.custom ?? '';
    updateCustomModel();
  }
  function applySettings(value) {
    provider.value = value.provider;
    activeProvider = value.provider;
    const preset = modelOptions[value.provider].includes(value.model);
    renderModels({ model:preset ? value.model : customModelOption, custom:preset ? '' : value.model });
    language.value = value.sourceLang;
    rate.value = value.sampleFps;
    width.value = String(value.frameWidth);
    smart.checked = value.smartAccuracy;
    $('ocrContentMode').value=value.contentMode==='variety'?'variety':'faithful';
    setRegion(value.region);
  }
  applySettings(settings);
  scope.value = settings.scope;
  $('ocrResultMode').value=settings.resultMode||'apply';
  if(Number.isInteger(settings.maxNewRequests))$('ocrBudget').value=String(settings.maxNewRequests);
  for(const input of [scope,provider,model,customModel,language,rate,width,smart,$('ocrContentMode'),$('ocrResultMode')]){
    input.addEventListener('change',invalidatePreview);
  }
  scope.addEventListener('change', updateScope);
  function updateKeyStatus() {
    $('ocrKeyStatus').textContent = hasApiKey[provider.value]
      ? '此供應商的金鑰已就緒。留空沿用，輸入新金鑰即可更新。'
      : '尚未儲存此供應商的金鑰，開始前請填入。';
    $('ocrAccuracyHelp').textContent = provider.value === 'openai'
      ? '智慧精準辨識會補抽短字卡，以 gpt-5.4 複檢疑難畫面並校對原文；複檢不降低所選解析度，增加 API 用量。'
      : `智慧精準辨識會補抽短字卡，以 ${defaultModels.gemini} 複檢疑難畫面並校對原文。複檢使用所選解析度，會增加 API 用量。`;
  }
  provider.addEventListener('change', () => {
    modelDrafts[activeProvider] = { model:model.value, custom:customModel.value };
    activeProvider = provider.value;
    renderModels(modelDrafts[activeProvider]);
    clearKey();
    updateKeyStatus();
  });
  model.addEventListener('change', () => {
    updateCustomModel();
    if (model.value === customModelOption) customModel.focus();
  });
  customModel.addEventListener('input', () => customModel.setCustomValidity(''));
  updateScope();
  const controls = [provider, model, customModel, language, rate, width, smart, apiKey];
  controls.forEach(control => { control.disabled = true; });
  void (async () => {
    try {
      const stored = await window.subtool.getScreenTextSettings();
      if (!session.isCurrent()) return;
      hasApiKey = stored.hasApiKey || {};
      if (!failure) applySettings(stored);
      loading = false;
      controls.forEach(control => { control.disabled = false; });
      updateCustomModel();
      updateKeyStatus();
      updateScope();
    } catch (err) {
      if (!session.isCurrent()) return;
      error.textContent = err?.message || '無法讀取畫面文字辨識設定。';
      error.hidden = false;
    }
  })();

  function updateScope() {
    const sourceLabel = $('ocrScopeSource'), bounds = $('ocrScopeRange'), scopeError = $('ocrScopeError');
    const defaults = $('ocrScopeDefault');
    sourceLabel.textContent = scope.value === 'clip' ? clip.name || '影片片段' : '';
    bounds.textContent = '';
    defaults.hidden = true;
    try {
      const changed = sourceChanged(scope.value);
      if (changed) throw new Error(changed);
      if (scope.value === 'export') {
        const unset = [];
        if (State.exportIn == null) unset.push('In 採時間軸起點');
        if (State.exportOut == null) unset.push('Out 採時間軸終點');
        defaults.textContent = unset.join('，');
        defaults.hidden = unset.length === 0;
      }
      const plan = $('ocrResultMode').value==='trial' ? screenTextTrialPlan(clip,scope.value) : getScreenTextPlan(clip, scope.value);
      if (scope.value !== 'clip') {
        const clipCount = new Set(plan.windows.map(window => window.clip)).size;
        sourceLabel.textContent = `${clipCount} 個影片片段`;
      }
      bounds.textContent = rangeLabel(plan.range, plan.fps, plan.dropFrame);
      scopeError.hidden = true;
      $('ocrStart').disabled = loading || starting;
      $('ocrStart').textContent=$('ocrResultMode').value==='trial'?'辨識這段':'開始辨識';
      return true;
    } catch (err) {
      if (err.range) bounds.textContent = rangeLabel(err.range, State.fps, State.dropFrame);
      scopeError.textContent = err.message || '這個範圍沒有可辨識的影片。';
      scopeError.hidden = false;
      $('ocrStart').disabled = true;
      return false;
    }
  }
  $('ocrResultMode').addEventListener('change',updateScope);

  async function start() {
    if (!session.isCurrent() || loading || starting) return;
    if (needsMonitor(getScreenTextSession())) { openScreenTextMonitorDialog(); return; }
    const changed = sourceChanged(scope.value);
    if (changed) { session.close(); showToast(changed); return; }
    const selectedModel = model.value === customModelOption ? customModel.value.trim() : model.value;
    customModel.setCustomValidity(model.value === customModelOption
      && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(selectedModel) ? '請輸入有效的視覺模型名稱。' : '');
    if (!rate.reportValidity() || !model.reportValidity() || !customModel.reportValidity()) return;
    const budget=$('ocrBudget');if(!budget.reportValidity())return;
    if (budget.valueAsNumber!==0 && !hasApiKey[provider.value] && !apiKey.value.trim()) {
      error.textContent = '請填入此供應商的 API 金鑰。';
      error.hidden = false;
      apiKey.focus();
      return;
    }
    const options = { provider:provider.value, model:selectedModel, sourceLang:language.value,
      sampleFps:rate.valueAsNumber, frameWidth:Number(width.value), smartAccuracy:smart.checked, scope:scope.value };
    try { options.region=getRegion(); } catch(e){error.hidden=false;error.textContent=e.message;return;}
    options.contentMode=$('ocrContentMode').value;
    options.resultMode=$('ocrResultMode').value;
    if(budget.value!=='')options.maxNewRequests=budget.valueAsNumber;
    const previousPreview=cancelPlan();
    let job;
    starting = true;
    $('ocrStart').disabled = true;
    controls.forEach(control => { control.disabled = true; });
    scope.disabled = true;
    try {
      if(previousPreview)await previousPreview;
      if(!session.isCurrent()||!ownsWorkspace())return;
      const persisted = { ...options };
      delete persisted.scope;delete persisted.resultMode;delete persisted.maxNewRequests;
      persisted.region=options.region??null;
      const saved = await window.subtool.saveScreenTextSettings({ ...persisted,
        ...(apiKey.value.trim() ? { apiKey:apiKey.value.trim() } : {}) });
      clearKey();
      if (!session.isCurrent()) return;
      hasApiKey = saved.hasApiKey || {};
      const changed = sourceChanged(options.scope);
      if (changed) { session.close(); showToast(changed); return; }
      if (needsMonitor(getScreenTextSession())) { openScreenTextMonitorDialog(); return; }
      job = startScreenTextSession(clip, options);
    } catch (err) {
      clearKey();
      if (!session.isCurrent()) return;
      starting = false;
      controls.forEach(control => { control.disabled = false; });
      updateCustomModel();
      scope.disabled = false;
      updateKeyStatus();
      if (!updateScope()) { error.hidden = true; return; }
      error.textContent = err?.message || '畫面文字辨識失敗，請重試。';
      error.hidden = false;
      return;
    }
    rememberSource(job, source);
    showMonitor(job);
  }
}

export function openScreenTextMonitorDialog() {
  if(openRecognitionReview('screen')) return;
  const job = getScreenTextSession();
  if (job && !monitorModal?.isCurrent()) showMonitor(job);
}

function showMonitor(job) {
  const { id } = job;
  const source = retrySource;
  let unsubscribe = () => {};
  function detach() {
    unsubscribe();
    monitorModal = null;
    setScreenTextDialogOpen(id, false);
  }
  const modal = openModal('畫面文字辨識進度', `
    <div class="asr-workspace">
      <section class="asr-card asr-progress-card ocr-monitor-card">
        <strong>${escapeHTML(job.clipName)}</strong>
        <p id="ocrMonitorRange" class="asr-helper">${rangeLabel(job.range, job.fps, job.dropFrame)}</p>
        <p class="asr-helper ocr-monitor-settings">${escapeHTML(languageNames[job.sourceLang] || '自動判斷')}　·　${escapeHTML(job.model)}　·　每秒 ${job.sampleFps} 張</p>
        <label id="ocrStatus" for="ocrProgressBar" role="status"></label><p id="ocrUsage" class="asr-helper"></p>
        <progress id="ocrProgressBar" max="1"></progress>
      </section>
      <p id="ocrBackgroundHelp" class="asr-helper">縮小後可繼續剪輯，點選右上工具列的畫面文字辨識按鈕可查看進度。</p>
    </div>`, [
    { label:'取消辨識', id:'ocrCancel', className:'asr-danger-button', act:() => {
      if (modal.isCurrent()) cancelScreenTextSession(id);
    } },
    { label:'縮小至背景', id:'ocrMinimize', primary:true, act:() => {
      if (!modal.isCurrent()) return;
      if (needsMonitor(getScreenTextSession())) modal.close();
      else acknowledge();
    } },
    { label:'捨棄結果', id:'ocrDiscardPartial', className:'asr-danger-button',
      act:() => { if (modal.isCurrent()) resolveScreenTextPartial(id, false); } },
    { label:'加入字幕軌', id:'ocrKeepPartial',
      act:() => { if (modal.isCurrent()) resolveScreenTextPartial(id, true); } },
  ], { width:'480px', closeOnBackdrop:false, onDismiss:detach, onReplaced:detach });
  monitorModal = modal;
  const primary = $('ocrMinimize');

  function acknowledge() {
    if (!modal.isCurrent()) return;
    unsubscribe();
    monitorModal = null;
    modal.close({ committed:true });
    clearScreenTextSession(id);
  }
  function render(snapshot) {
    if (!modal.isCurrent()) return;
    if (snapshot?.id !== id) { modal.close(); return; }
    if(snapshot.status==='review'){unsubscribe();monitorModal=null;modal.close({committed:true});openRecognitionReview('screen');return;}
    if (snapshot.status === 'failed' && source?.id === id) {
      acknowledge();
      openSettings(source, {...snapshot, maxNewRequests:Number.isInteger(snapshot.maxNewRequests)
        ?Math.max(0,snapshot.maxNewRequests-(snapshot.metrics?.newRequests||0)):undefined},snapshot.message || '畫面文字辨識失敗，請重試。');
      return;
    }
    const active = isActive(snapshot);
    const partial = snapshot.status === 'partial';
    const bar = $('ocrProgressBar'), status = $('ocrStatus');
    const percent = Number.isFinite(snapshot.progress) ? Math.round(snapshot.progress * 100) : null;
    if (percent === null) bar.removeAttribute('value'); else bar.value = snapshot.progress;
    bar.hidden = !active;
    status.textContent = snapshot.message + (active && percent !== null ? `　${percent}%` : '');
    const usage=snapshot.metrics;
    $('ocrUsage').textContent=usage||!active?screenTextUsageLabel(usage):'';
    status.setAttribute('role', snapshot.status === 'failed' ? 'alert' : 'status');
    $('ocrBackgroundHelp').hidden = !active;
    $('ocrCancel').hidden = !active;
    $('ocrCancel').disabled = snapshot.status === 'cancelling';
    $('ocrDiscardPartial').hidden = !partial;
    $('ocrKeepPartial').hidden = !partial;
    $('ocrKeepPartial').classList.toggle('primary', partial);
    primary.classList.toggle('primary', !partial);
    primary.id = partial ? 'ocrLater' : active ? 'ocrMinimize' : 'ocrClose';
    primary.textContent = partial ? '稍後決定' : active ? '縮小至背景' : '關閉';
  }
  setScreenTextDialogOpen(id, true);
  unsubscribe = onScreenTextSessionChange(render);
  render(getScreenTextSession());
}
