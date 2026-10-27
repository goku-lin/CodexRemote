export function isLocalHtml(ref){
  return typeof ref==='string' && ref.length<=2048 && !/^(?!file:|[a-z]:[\\/])[a-z][a-z0-9+.-]*:/i.test(ref) && /\.html?(?:[?#].*)?$/i.test(ref.trim());
}
export function isLocalDocument(ref){
  return typeof ref==='string' && ref.length<=2048 && !/^(?!file:|[a-z]:[\\/])[a-z][a-z0-9+.-]*:/i.test(ref) && /\.(?:md|markdown|txt)(?::\d+)?(?:[?#].*)?$/i.test(ref.trim());
}
export const isLocalPreview=ref=>isLocalHtml(ref)||isLocalDocument(ref);
export function htmlLinkMatches(text=''){
  text=String(text);const links=[];
  for(const match of text.matchAll(/\[([^\]\n]+)\]\(/g)){
    if(text[match.index-1]==='!')continue;
    const start=match.index,offset=start+match[0].length;let end=offset,ref;
    if(text[offset]==='<'){
      const close=text.indexOf('>',offset+1);if(close<0 || text[close+1]!==')')continue;
      ref=text.slice(offset+1,close);end=close+2;
    }else{
      let depth=1;
      for(;end<text.length && text[end]!=='\n';end++){
        if(text[end]==='(')depth++;else if(text[end]===')' && --depth===0)break;
      }
      if(depth!==0)continue;ref=text.slice(offset,end);end++;
    }
    ref=ref.trim();if(isLocalPreview(ref))links.push({start,end,label:match[1],ref,interactive:false});
  }
  for(const match of text.matchAll(/visualize(\{[^\n]*?\})/g)){
    try{const {path:ref}=JSON.parse(match[1]);if(isLocalHtml(ref))links.push({start:match.index,end:match.index+match[0].length,label:'查看交互预览',ref,interactive:true});}catch{}
  }
  return links.sort((a,b)=>a.start-b.start).filter((link,index,all)=>!index || link.start>=all[index-1].end);
}
export function htmlReferences(text=''){
  return htmlLinkMatches(text).map(link=>link.ref);
}
export function htmlPreviewUrl(sessionId,ref,{interactive=false}={}){
  if(!sessionId || !isLocalPreview(ref))return null;
  const token=btoa(encodeURIComponent(ref)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  const filename=ref.split(/[?#]/)[0].replace(/\.(md|markdown|txt):\d+$/i,'.$1').split(/[\\/]/).at(-1);
  const fragment=ref.includes('#') ? '#'+ref.split('#').slice(1).join('#') : '';
  return `/api/sessions/${encodeURIComponent(sessionId)}/preview/${token}/${encodeURIComponent(filename)}${interactive ? '?interactive=1' : ''}${fragment}`;
}
