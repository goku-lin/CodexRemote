// Node's false write result means "accepted, but backpressured", not failure.
// A bounded buffer and drain deadline disconnect a slow peer; EventSource then
// receives a fresh snapshot. Never retransmit uncertain mutating commands.
export class SseWriter {
  constructor({maxBytes=1024*1024,drainMs=15000}={}){this.maxBytes=maxBytes;this.drainMs=drainMs;this.blocked=new WeakMap();}
  send(res,event,value){
    if(res.destroyed || res.writableEnded)return false;
    const frame=`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`;
    if(Buffer.byteLength(frame)+(res.writableLength || 0)>this.maxBytes){res.destroy();return false;}
    try{
      if(!res.write(frame) && !this.blocked.has(res)){
        const clear=()=>{const timer=this.blocked.get(res);clearTimeout(timer);this.blocked.delete(res);res.removeListener('drain',clear);res.removeListener('close',clear);};
        const timer=setTimeout(()=>{clear();res.destroy();},this.drainMs);timer.unref?.();this.blocked.set(res,timer);res.once('drain',clear);res.once('close',clear);
      }
      return true;
    }catch{res.destroy();return false;}
  }
}
