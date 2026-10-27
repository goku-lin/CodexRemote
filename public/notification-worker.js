const APP_NOTIFICATION_ICON='/app-icon-192.png';
// Only public application files are cached. API, attachments and previews
// always use the network; authenticated responses never enter this cache.
const SHELL_CACHE='codex-relay-shell-845ad8077b93e1a3';
const SHELL_ASSETS=["/index.html","/styles.css","/app-icon.svg","/app-icon-192.png","/app-icon-512.png","/access.js","/agent-tasks.js","/app-icon-themes.js","/app-install.js","/app-update-page.js","/app-updates.js","/app.js","/background-notices.js","/chatgpt-markdown.js","/chatgpt-mode.js","/command-timing.js","/composer-settings.js","/computer-entries.js","/connection-state.js","/connectors.js","/context-state.js","/context-tools.js","/device-names.js","/device-selection.js","/direct-connection.js","/dom-sync.js","/goal-strip.js","/history-preload.js","/history-sync.js","/html-links.js","/latest-navigation.js","/local-images.js","/maintenance.js","/media-cards.js","/media-types.js","/mobile-layout.js","/model-preferences.js","/native-requests.js","/network-check.js","/peer-wire.js","/performance-settings-ui.js","/performance-settings.js","/project-management.js","/project-order.js","/project-sort.js","/questions.js","/reliability.js","/remote-browser.js","/render-cache.js","/resume-cache.js","/runtime-status.js","/service-health.js","/session-attention.js","/session-search.js","/session-status.js","/timeline-scroll.js","/turn-controls.js","/unread-navigation.js","/uploads.js","/usage-range.js","/usage.js"];
self.addEventListener('install',event=>event.waitUntil((async()=>{const cache=await caches.open(SHELL_CACHE);await cache.addAll(SHELL_ASSETS.map(url=>new Request(url,{cache:'reload'})));})()));
self.addEventListener('activate',event=>event.waitUntil((async()=>{for(const name of await caches.keys())if(name.startsWith('codex-relay-shell-')&&name!==SHELL_CACHE)await caches.delete(name);await self.clients.claim();})()));
self.addEventListener('message',event=>{if(event.data?.type==='activate_app_update')self.skipWaiting();});
self.addEventListener('fetch',event=>{
 const request=event.request,url=new URL(request.url);
 if(request.method!=='GET'||url.origin!==self.location.origin)return;
 const key=url.pathname==='/'?'/index.html':url.pathname;
 if(!SHELL_ASSETS.includes(key))return;
 event.respondWith((async()=>{const cache=await caches.open(SHELL_CACHE);return await cache.match(key)||fetch(request);})());
});
self.addEventListener('notificationclick',event=>{
  event.notification.close();
  const sessionId=event.notification.data?.sessionId;if(typeof sessionId!=='string')return;
  event.waitUntil((async()=>{
    const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});
    const existing=windows.find(client=>new URL(client.url).origin===self.location.origin && new URL(client.url).pathname==='/');
    if(existing){existing.postMessage({type:'open_notice_session',sessionId});await existing.focus();}
    else await self.clients.openWindow('/?noticeSession='+encodeURIComponent(sessionId));
  })());
});
self.addEventListener('push',event=>{
  event.waitUntil((async()=>{
    let payload={};try{payload=event.data?.json()||{};}catch{}
    const title=typeof payload.title==='string'?payload.title.slice(0,100):'Codex · 有任务需要查看';
    const body=typeof payload.body==='string'?payload.body.slice(0,180):'打开应用查看最新状态。';
    const sessionId=typeof payload.sessionId==='string'&&payload.sessionId.length<256?payload.sessionId:null;
    await self.registration.showNotification(title,{body,tag:typeof payload.tag==='string'?payload.tag.slice(0,300):'codex-background',icon:APP_NOTIFICATION_ICON,data:{sessionId},renotify:false});
  })());
});
