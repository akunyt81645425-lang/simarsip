(()=>{
  const screen=document.getElementById('introScreen');
  if(!screen)return;
  const seenKey='simarsip:intro-seen';
  let escapeHandler;
  const close=()=>{
    if(screen.classList.contains('intro-hidden'))return;
    try{sessionStorage.setItem(seenKey,'1')}catch(error){}
    if(escapeHandler)document.removeEventListener('keydown',escapeHandler);
    screen.classList.add('intro-hidden');
    screen.setAttribute('aria-hidden','true');
    window.setTimeout(()=>screen.remove(),850);
  };
  try{
    if(sessionStorage.getItem(seenKey)){
      screen.remove();
      return;
    }
  }catch(error){}
  document.getElementById('introSkip')?.addEventListener('click',close);
  escapeHandler=event=>{if(event.key==='Escape')close()};
  document.addEventListener('keydown',escapeHandler);
  const duration=window.matchMedia('(prefers-reduced-motion: reduce)').matches?1800:5600;
  window.setTimeout(close,duration);
})();
