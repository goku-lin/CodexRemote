export function connectionExperience({connection,device,cached=false,accessRequired=false,needsDesktop=true}={}){
  if(accessRequired || connection==='unauthorized')return {kind:'error',text:'需要重新配对；输入已保留',show:true};
  if(connection==='offline')return {kind:'warning',text:cached?'网络未连接，当前是本机保存的对话；草稿可继续编辑':'网络未连接，输入已保留',show:true};
  if(connection!=='connected')return {kind:'warning',text:cached?'已恢复上次的文字，正在连接并核对最新内容…':'正在恢复连接，输入已保留',show:true};
  if(!device?.online)return {kind:'warning',text:'可查看已有内容，执行电脑尚未连接，暂不能发送',show:true};
  if(needsDesktop && device.nativeDesktop?.connected===false)return {kind:'warning',text:'可查看历史，桌面接管未连接，暂不能继续桌面对话；点“连接检查”查看详情',show:true};
  if(cached)return {kind:'warning',text:'连接已恢复，正在核对上次保存的对话…',show:true};
  return {kind:'ready',text:'可正常聊天',show:false};
}
