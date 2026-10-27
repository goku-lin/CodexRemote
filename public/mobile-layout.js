export function keyboardLayout({mobile,focused,height,baseline,scale=1}){
  return Boolean(mobile&&focused&&scale<1.15&&baseline-height>Math.max(140,baseline*.2));
}
export function setupMobileLayout({window:win=window,document:doc=document,onResize=()=>{}}={}){
  const field=doc.getElementById('promptInput'),expand=doc.getElementById('expandComposerBtn'),composer=doc.getElementById('composer'),more=doc.getElementById('composerMoreBtn');let baseline=win.innerHeight;
  const setExpanded=large=>{
    doc.documentElement.classList.toggle('composer-expanded',large);
    if(expand){const label=large?'收起输入框':'展开输入框';expand.setAttribute('aria-expanded',String(large));expand.setAttribute('aria-label',label);expand.title=label;const text=expand.querySelector('.composer-expand-label');if(text)text.textContent=label;}
  };
  const closeTools=()=>{composer?.classList.remove('tools-open');more?.setAttribute('aria-expanded','false');};
  more?.addEventListener('click',()=>{const open=composer.classList.toggle('tools-open');more.setAttribute('aria-expanded',String(open));});
  doc.addEventListener('pointerdown',event=>{if(!event.target.closest('#composer'))closeTools();});
  doc.addEventListener('keydown',event=>{if(event.key==='Escape')closeTools();});
  const update=()=>{
    const mobile=win.matchMedia('(max-width:650px)').matches,view=win.visualViewport;
    const focused=doc.activeElement===field,height=view?.height || win.innerHeight;
    if(!focused)baseline=Math.max(win.innerHeight,height);else baseline=Math.max(baseline,win.innerHeight);
    const compact=keyboardLayout({mobile,focused,height,baseline,scale:view?.scale || 1});
    doc.documentElement.classList.toggle('keyboard-open',compact);
    if(mobile&&view)doc.documentElement.style.setProperty('--app-height',`${Math.round(height)}px`);
    else doc.documentElement.style.removeProperty('--app-height');
    if(!focused&&!field.value)setExpanded(false);
    onResize();
  };
  expand?.addEventListener('click',()=>{setExpanded(!doc.documentElement.classList.contains('composer-expanded'));field.focus();});
  win.visualViewport?.addEventListener('resize',update);win.addEventListener('resize',update);doc.addEventListener('focusin',update);doc.addEventListener('focusout',()=>win.setTimeout(update,100));
  win.addEventListener('orientationchange',()=>{baseline=0;win.setTimeout(update,300);});update();return update;
}
