export function setupThreadOwnership({api,session,confirm=message=>window.confirm(message)}){
  const button=document.getElementById('ownershipCheckBtn'),release=document.getElementById('ownershipReleaseBtn'),status=document.getElementById('ownershipResult');
  let snapshot=null,busy=false;
  const reset=()=>{snapshot=null;release.hidden=true;status.textContent='桌面提示“已在另一个应用中打开”时，检查当前对话由谁持有。';};
  document.getElementById('healthOpenBtn').addEventListener('click',reset);
  button.onclick=async()=>{
    if(busy)return;const current=session();reset();if(!current?.threadId){status.textContent='请先打开要检查的对话。';return;}
    busy=true;button.disabled=true;
    try{
      const result=await api('/api/sessions/'+encodeURIComponent(current.id)+'/ownership');
      if(session()?.id!==current.id){status.textContent='当前对话已切换，请重新检查。';return;}
      snapshot={...result,sessionId:current.id};
      status.textContent=result.owner==='runner' ? result.canRelease ? '独立执行器持有此对话，当前为空闲。可以释放后回桌面点“重试”。' : '独立执行器持有此对话，仍有任务或请求。请等待完成后重新检查。' : result.owner==='desktop' ? '桌面原生执行器持有此对话，独立 Runner 未占用。若桌面曾闪退，可能仍连接着旧桌面进程；这里不会结束它。' : '未确认占用者，可能是其他 Codex 窗口或 CLI。未结束任何进程。';
      release.hidden=!result.canRelease;
    }catch(error){status.textContent=error.message==='not found' ? '该电脑后台尚未加载占用诊断，请先更新连接器。' : error.message;}finally{busy=false;button.disabled=false;}
  };
  release.onclick=async()=>{
    if(busy || !snapshot?.canRelease)return;
    const current=session();if(current?.id!==snapshot.sessionId){reset();status.textContent='当前对话已切换，请重新检查。';return;}
    if(!confirm('将重新启动空闲的独立执行器以释放会话占用。Codex 桌面和远程服务保持运行；发现任何执行中任务时会拒绝。是否继续？'))return;
    busy=true;release.disabled=true;button.disabled=true;
    try{const result=await api('/api/sessions/'+encodeURIComponent(current.id)+'/ownership',{method:'POST',body:JSON.stringify({confirm:true,expected:{pid:snapshot.pid,generation:snapshot.generation}})});status.textContent=result.message;}
    catch(error){status.textContent=error.message;}
    finally{snapshot=null;release.hidden=true;release.disabled=false;button.disabled=false;busy=false;}
  };
  reset();
}
