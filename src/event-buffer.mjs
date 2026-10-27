// Only unsent, adjacent deltas are merged. Retried batches stay byte-identical:
// the receiver may have accepted a request whose HTTP response was lost.
const deltaMethods = new Set(['item/agentMessage/delta', 'item/reasoning/textDelta', 'item/reasoning/summaryTextDelta', 'item/commandExecution/outputDelta']);
const deltaKey = event => deltaMethods.has(event.message?.method) ? JSON.stringify([event.message.method,event.message.params?.threadId,event.message.params?.turnId,event.message.params?.itemId,event.message.params?.summaryIndex,event.message.params?.contentIndex]) : null;
const size = event => Buffer.byteLength(JSON.stringify(event));

export class EventBuffer {
  constructor({maxEvents=2000,maxBytes=4*1024*1024,maxDeltaBytes=12000}={}) {
    Object.assign(this,{maxEvents,maxBytes,maxDeltaBytes}); this.entries=[];this.bytes=0;this.dropped=0;this.gapThreads=new Set();this.gapItems=new Map();
  }
  get length(){return this.entries.length;}
  gap(event){this.dropped++;const params=event.message?.params || {},id=params.threadId;if(id && this.gapThreads.size<1000)this.gapThreads.add(id);const itemId=params.itemId || params.item?.id;if(id && itemId && this.gapItems.size<2000)this.gapItems.set(JSON.stringify([id,itemId]),{threadId:id,itemId});}
  push(event){
    const key=deltaKey(event),last=this.entries.at(-1);
    if(key && last && !last.sent && last.key===key && Buffer.byteLength(String(last.event.message.params.delta || '')+String(event.message.params.delta || ''))<=this.maxDeltaBytes){
      const merged={...event,message:{...event.message,params:{...event.message.params,delta:last.event.message.params.delta+event.message.params.delta}}};
      const bytes=size(merged);this.bytes+=bytes-last.bytes;last.event=merged;last.bytes=bytes;
    }else{const bytes=size(event);if(bytes>this.maxBytes){this.gap(event);return;}this.entries.push({event,bytes,key,sent:false});this.bytes+=bytes;}
    while(this.entries.length>this.maxEvents || this.bytes>this.maxBytes){
      let index=this.entries.findIndex(entry=>!entry.sent && entry.key);
      if(index<0)index=this.entries.findIndex(entry=>!entry.sent);
      if(index<0)break; // reserved batches are capped below the buffer budget
      const [removed]=this.entries.splice(index,1);this.bytes-=removed.bytes;this.gap(removed.event);
    }
  }
  take(maxEvents=100,maxBytes=512*1024){
    const batch=[];let bytes=0;
    for(const entry of this.entries){if(batch.length && (batch.length>=maxEvents || bytes+entry.bytes>maxBytes))break;entry.sent=true;batch.push(entry.event);bytes+=entry.bytes;}
    return batch;
  }
  ack(batch){const ids=new Set(batch.map(event=>event.sequence));this.entries=this.entries.filter(entry=>{if(!ids.has(entry.event.sequence))return true;this.bytes-=entry.bytes;return false;});}
  takeGap(){if(!this.dropped)return null;const gap={dropped:this.dropped,threadIds:[...this.gapThreads],items:[...this.gapItems.values()]};this.dropped=0;this.gapThreads.clear();this.gapItems.clear();return gap;}
}
