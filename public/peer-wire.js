// RTC/SCTP message sizes vary by browser; split into small, bounded frames.
export class PeerWire {
  constructor({send,onMessage,maxBytes=24_000_000}){Object.assign(this,{send,onMessage,maxBytes});this.incoming=new Map();this.serial=0;this.buffered=0;}
  async write(value){
    const text=JSON.stringify(value);if(text.length>this.maxBytes)throw new Error('直连消息过大');
    const id=String(++this.serial),count=Math.max(1,Math.ceil(text.length/6000));
    for(let i=0;i<count;i++)await this.send(JSON.stringify({id,i,count,text:text.slice(i*6000,(i+1)*6000)}));
  }
  read(raw){
    try{
      if(typeof raw!=='string' || raw.length>40_000)throw new Error('frame');
      const frame=JSON.parse(raw);
      if(typeof frame.id!=='string' || frame.id.length>40 || !Number.isInteger(frame.count) || frame.count<1 || frame.count>4000 || !Number.isInteger(frame.i) || frame.i<0 || frame.i>=frame.count || typeof frame.text!=='string' || frame.text.length>6000)throw new Error('frame');
      for(const [id,old] of this.incoming)if(Date.now()-old.at>30_000){this.buffered-=old.size;this.incoming.delete(id);}
      let item=this.incoming.get(frame.id);
      if(!item){if(this.incoming.size>=32)throw new Error('frames');item={count:frame.count,parts:new Map(),size:0,at:Date.now()};this.incoming.set(frame.id,item);}
      if(item.count!==frame.count || item.parts.has(frame.i))return;
      item.parts.set(frame.i,frame.text);item.size+=frame.text.length;this.buffered+=frame.text.length;
      if(this.buffered>this.maxBytes)throw new Error('overflow');
      if(item.parts.size===item.count){this.incoming.delete(frame.id);this.buffered-=item.size;this.onMessage(JSON.parse(Array.from({length:item.count},(_,i)=>item.parts.get(i)).join('')));}
    }catch{this.incoming.clear();this.buffered=0;}
  }
}
