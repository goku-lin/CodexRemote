import {createHash} from 'node:crypto';

export const messageKey = event => event.id || `user-${event.turnId || event.turn_id || event.at}`;
export const messageToken = event => createHash('sha256').update(JSON.stringify([messageKey(event),event.turnId,event.text,event.images])).digest('hex');
export const userText = item => item.text || (item.content || []).map(part=>part.text || '').join('').trim();

export function editableMessages(session) {
  const latest=session.liveTurn?.id || session.turns?.at(-1)?.id;
  return latest ? (session.events || []).filter(event=>event.type==='user_message' && event.turnId)
    .map(event=>({id:messageKey(event),token:messageToken(event),lastTurnId:latest})) : [];
}

function imageInput(item) {
  const content=item.content || [];
  const images=content.filter(part=>['image','localImage','input_image','local_image'].includes(part.type)).map(part=>{
    if(part.type==='localImage' || part.type==='local_image')return {type:'localImage',path:part.path};
    return {type:'image',url:part.url || part.image_url?.url || part.image_url};
  });
  if(!images.length)for(const image of item.images || []) {
    if(image.path)images.push({type:'localImage',path:image.path});
    else if(image.url)images.push({type:'image',url:image.url});
    else throw new Error('原消息的图片尚未完整读取，未修改对话。');
  }
  if(images.some(part=>!part.url && !part.path))throw new Error('原消息的图片尚未完整读取，未修改对话。');
  return images;
}

// Validate the authoritative thread immediately before changing its history.
// Editing a steer preserves earlier user inputs in that same turn.
export function prepareMessageEdit(thread, command) {
  if(thread?.id!==command.threadId || !Array.isArray(thread.turns))throw new Error('原对话历史尚未完整读取，未修改对话。');
  if(thread.status?.type==='active' || thread.turns.some(turn=>turn.status==='inProgress'))throw new Error('原回合仍在运行，请先等待完成或中断后再编辑。');
  const latest=thread.turns.at(-1)?.id || null;
  if(latest!==command.expectedLastTurnId)throw new Error('对话已经有新消息，请同步后重新编辑。');
  if(command.recoveryInput)return {input:command.recoveryInput,numTurns:0};
  const index=thread.turns.findIndex(turn=>turn.id===command.editTurnId);
  if(index<0)throw new Error('这条消息已改变，请同步后重新编辑。');
  const users=(thread.turns[index].items || []).filter(item=>item.type==='userMessage');
  let userIndex=users.findIndex(item=>item.id===command.messageId);
  if(userIndex<0) {
    const matches=users.map((item,index)=>userText(item)===command.originalText ? index : -1).filter(index=>index>=0);
    if(matches.length!==1)throw new Error('这条消息无法准确定位，请同步后重新编辑。');
    userIndex=matches[0];
  }
  if(userText(users[userIndex])!==command.originalText)throw new Error('原消息内容已改变，请同步后重新编辑。');
  let prefixLength=0;
  const input=users.slice(0,userIndex+1).flatMap((item,index)=>{
    const text=index===userIndex ? command.text : userText(item);
    const parts=[...(text ? [{type:'text',text}] : []),...imageInput(item)];
    if(index<userIndex)prefixLength+=parts.length;
    return parts;
  });
  if(!input.length)throw new Error('请输入消息或保留原图片。');
  return {input,prefixLength,numTurns:thread.turns.length-index};
}
