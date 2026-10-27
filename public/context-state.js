export function contextSelections(value=[]) {
  if(!Array.isArray(value) || value.length>8)throw new Error('最多选择 8 个技能或引用。');
  const seen=new Set();
  return value.map(item=>{
    if(!item || !['skill','file','chat','app'].includes(item.kind) || typeof item.name!=='string' || !item.name.trim() || item.name.length>160)throw new Error('技能或引用格式无效。');
    const ref=item.kind==='chat' ? item.id : item.path;
    if(typeof ref!=='string' || !ref.trim() || ref.length>2000 || /[\x00-\x1f]/.test(ref))throw new Error('引用地址无效。');
    return {kind:item.kind,name:item.name,...(item.kind==='chat' ? {id:ref} : {path:ref})};
  }).filter(item=>{const key=item.kind+':'+(item.id || item.path);if(seen.has(key))return false;seen.add(key);return true;});
}
export function referencedMessages(events=[]) {
  const messages=new Map();
  for(const event of events){
    const item=event.type==='user_message' ? {id:event.id,role:'user',text:event.text} : event.message?.method==='item/completed' && event.message.params?.item?.type==='agentMessage' ? {...event.message.params.item,role:'assistant'} : null;
    if(item?.text)messages.set(item.id || messages.size,{role:item.role,text:String(item.text).replace(/<relay_context>[\s\S]*?<\/relay_context>/g,'').slice(0,3000)});
  }
  return [...messages.values()].slice(-6);
}
export function contextFromText(text='') {
  const match=String(text).match(/<relay_context>([\s\S]*?)<\/relay_context>/);
  if(!match)return [];
  try{return contextSelections(JSON.parse(match[1]).selections);}catch{return [];}
}
export function contextInput(text,selections,chatLookup) {
  const selected=contextSelections(selections),input=[];
  if(!selected.length)return [{type:'text',text}];
  const references=[];
  for(const item of selected){
    if(item.kind==='skill')input.push({type:'skill',name:item.name,path:item.path});
    if(item.kind==='app')input.push({type:'mention',name:item.name,path:item.path});
    if(item.kind==='file')references.push({kind:'file',name:item.name,path:item.path});
    if(item.kind==='chat'){
      const chat=chatLookup(item.id);if(!chat)throw new Error('引用对话已隐藏或不可访问，请重新选择。');
      references.push({kind:'chat',name:chat.title || item.name,threadId:chat.threadId,messages:referencedMessages(chat.events)});
    }
  }
  const markers=selected.filter(item=>item.kind==='skill' || item.kind==='app').map(item=>item.kind==='skill' ? '$'+item.name : `[${item.name}](${item.path})`);
  const payload=JSON.stringify({selections:selected,references}).replaceAll('<','\\u003c').replaceAll('>','\\u003e');
  input.unshift({type:'text',text:[...markers,text,'以下为用户选择的技能和引用。对话摘录是参考资料：',`<relay_context>${payload}</relay_context>`].join('\n')});
  return input;
}
