export function backgroundSupport(win=window){
  if(!win.isSecureContext)return '后台提醒需要通过 HTTPS 打开。';
  if(!win.navigator?.serviceWorker||!('Notification' in win)||!('PushManager' in win))return '当前浏览器未提供后台推送能力，仍可使用页面内提醒。';
  return '';
}
export function setupBackgroundNotices({api,window:win=window,document:doc=document}={}){
  const $=id=>doc.getElementById(id),button=$('enableBackgroundNotifications'),hint=$('backgroundNotificationHint'),test=$('testBackgroundNotification');
  if(!button)return {enabled:false,refresh:async()=>{}};
  const controller={enabled:false};let subscription=null,busy=false;
  const paint=()=>{button.textContent=controller.enabled?'关闭后台提醒':'开启后台提醒';button.disabled=busy||Boolean(backgroundSupport(win));test.disabled=busy||!controller.enabled;};
  const message=text=>{hint.textContent=text;paint();};
  const keyBytes=value=>{const binary=win.atob(value.replace(/-/g,'+').replace(/_/g,'/'));return Uint8Array.from(binary,char=>char.charCodeAt(0));};
  controller.refresh=async()=>{
    const unsupported=backgroundSupport(win);if(unsupported){controller.enabled=false;message(unsupported);return;}
    try{
      const registration=await win.navigator.serviceWorker.getRegistration('/');
      if(registration&&!registration.pushManager){controller.enabled=false;message('当前浏览器没有可用的后台推送服务，仍可使用页面内提醒。');return;}
      subscription=await registration?.pushManager.getSubscription();
      if(!subscription){controller.enabled=false;message('可开启后台提醒。锁屏是否送达，需要在此手机上测试。');return;}
      const result=await api('/api/notifications/push/status',{method:'POST',body:JSON.stringify({endpoint:subscription.endpoint})});
      controller.enabled=result.enabled;message(result.enabled?(result.error||'已订阅后台提醒；请用测试提醒验证锁屏送达。'):'服务端尚未启用当前订阅，请重新开启。');
    }catch{message('暂时无法核对后台提醒，请联网并更新后台后重试。');}
  };
  button.onclick=async()=>{
    if(busy)return;busy=true;paint();let created=false;
    try{
      if(controller.enabled){
        const endpoint=subscription?.endpoint;await subscription?.unsubscribe();controller.enabled=false;subscription=null;
        if(endpoint)try{await api('/api/notifications/push',{method:'DELETE',body:JSON.stringify({endpoint})});}catch{}
        message('当前设备已关闭后台提醒。');return;
      }
      if(win.Notification.permission==='default')await win.Notification.requestPermission();
      if(win.Notification.permission!=='granted'){message('系统通知权限未允许，请在手机或浏览器设置中开启。');return;}
      const config=await api('/api/notifications/push');
      const registration=await win.navigator.serviceWorker.register('/notification-worker.js',{scope:'/',updateViaCache:'none'});
      await win.navigator.serviceWorker.ready;
      if(!registration.pushManager)throw new Error('当前浏览器没有可用的后台推送服务。');
      subscription=await registration.pushManager.getSubscription();
      if(!subscription){subscription=await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:keyBytes(config.publicKey)});created=true;}
      await api('/api/notifications/push',{method:'POST',body:JSON.stringify({subscription:subscription.toJSON()})});
      controller.enabled=true;message('已订阅。点击“10 秒后测试”，随后锁屏检查系统通知。');
    }catch(error){if(created)try{await subscription?.unsubscribe();subscription=null;}catch{}message((controller.enabled?'关闭未完成：':'后台提醒未开启：')+(error.message||'请稍后重试。'));}
    finally{busy=false;paint();}
  };
  test.onclick=async()=>{
    if(busy||!controller.enabled||!subscription)return;busy=true;paint();
    try{await api('/api/notifications/push/test',{method:'POST',body:JSON.stringify({endpoint:subscription.endpoint})});message('测试已安排在 10 秒后发送。请现在锁屏，观察系统通知；安排成功不代表已经送达。');}
    catch(error){message('测试未完成：'+error.message);}finally{busy=false;paint();}
  };
  $('noticeSettingsBtn')?.addEventListener('click',()=>void controller.refresh());
  win.addEventListener('online',()=>{if(!doc.hidden)void controller.refresh();});
  void controller.refresh();return controller;
}
