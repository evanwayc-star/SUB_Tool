function decimalPlaces(value){
  const text=String(value);
  if(/[eE]/.test(text)){
    const [,fraction='',exponent='0']=text.match(/^\d*\.?([0-9]*)[eE]([+-]?\d+)$/)||[];
    return Math.max(0,fraction.length-Number(exponent||0));
  }
  return (text.split('.')[1]||'').length;
}

export function nextWheelNumberValue(input,{deltaY,shiftKey=false}={}){
  if(!input||!Number.isFinite(Number(deltaY))||Number(deltaY)===0) return null;
  const declaredStep=Number(input.step);
  const baseStep=Number.isFinite(declaredStep)&&declaredStep>0?declaredStep:1;
  const step=baseStep*(shiftKey?10:1);
  const min=input.min!==''&&Number.isFinite(Number(input.min))?Number(input.min):-Infinity;
  const max=input.max!==''&&Number.isFinite(Number(input.max))?Number(input.max):Infinity;
  const current=Number.isFinite(Number(input.value))?Number(input.value):0;
  const direction=Number(deltaY)<0?1:-1;
  const precision=Math.min(10,decimalPlaces(input.step||baseStep));
  const next=Math.max(min,Math.min(max,current+direction*step));
  return Number(next.toFixed(precision));
}

export function bindNumberInputWheel(root=document){
  const onWheel=e=>{
    const input=e.target;
    if(!input||input.tagName!=='INPUT'||(input.type!=='number'&&!input.classList.contains('num-scrubber'))) return;
    const next=nextWheelNumberValue(input,e);
    if(next==null) return;
    e.preventDefault();
    input.value=String(next);
    input.dispatchEvent(new Event('input',{bubbles:true}));
    input.dispatchEvent(new Event('change',{bubbles:true}));
  };
  root.addEventListener('wheel',onWheel,{passive:false});
  return ()=>root.removeEventListener('wheel',onWheel);
}
