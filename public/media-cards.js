import {mediaKind,mediaName} from './media-types.js';

const escape=value=>String(value ?? '').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[char]));
const sizeLabel=bytes=>bytes>=1024*1024 ? (bytes/1024/1024).toFixed(1)+' MB' : Math.ceil(bytes/1024)+' KB';

export class MediaCards {
  constructor({sessionId,path,request,onChange,maxEntries=32}) {
    Object.assign(this,{sessionId,path,request,onChange,maxEntries});this.items=new Map();
  }

  render(ref,label,kind=mediaKind(ref)) {
    if(!kind)return '';
    const session=this.sessionId(),key=encodeURIComponent(JSON.stringify([session,ref]));
    const url=this.path(ref);if(!url)return escape(label || mediaName(ref));
    let item=this.items.get(key);
    if(!item)item={key,ref,url,kind,session,mode:null,generation:0};
    else{item.url=url;this.items.delete(key);this.items.set(key,item);}
    const name=label || item.info?.name || mediaName(ref);
    const info=item.info ? sizeLabel(item.info.size) : ({image:'图片',audio:'音频',video:'视频'})[kind];
    const button=(action,text,disabled=false)=>`<button type="button" class="media-button" data-media-action="${action}"${disabled ? ' disabled' : ''}>${text}</button>`;
    if(kind==='image') {
      // A normal lazy image defers network work to the browser. Resolving a peer
      // blob during render would eagerly download every offscreen thumbnail.
      const preview=this.variant(url,'preview','1');
      const source=item.generation ? this.variant(preview,'retry',String(item.generation)) : preview;
      const content=(item.error ? '' : `<img class="message-image" src="${escape(source)}" alt="${escape(name)}" width="164" height="132" loading="lazy" decoding="async" data-media-image />`)
        + `<span class="media-image-placeholder" data-media-image-failure${item.error ? '' : ' hidden'}>缩略图暂不可用</span>`;
      return `<span class="media-card" data-media-key="${key}" data-media-kind="image" data-node-key="media:${key}"><a class="media-thumbnail" href="${escape(url)}" target="_blank" rel="noopener noreferrer" title="打开原图">${content}</a><span class="media-image-caption"><span class="media-name" title="${escape(name)}">${escape(name)}</span><a href="${escape(url)}" target="_blank" rel="noopener noreferrer">打开原图 ↗</a></span><span data-media-image-failure${item.error ? '' : ' hidden'}><span class="media-error" role="status">可重试缩略图，或直接打开原图。</span>${button('preview','重试缩略图')}</span></span>`;
    }
    let content='';
    if(item.mode==='play')content=`<${kind==='audio' ? 'audio' : 'video'} controls preload="none" src="${escape(url)}" data-media-player data-node-key="player:${key}"></${kind==='audio' ? 'audio' : 'video'}>`;
    return `<span class="media-card" data-media-key="${key}" data-media-kind="${kind}" data-node-key="media:${key}"><span class="media-card-heading"><span aria-hidden="true">${kind==='audio' ? '♫' : '▶'}</span><span class="media-name">${escape(name)}</span><small>${escape(info)}</small></span><span class="media-card-actions">${item.mode || item.loading ? button('close','收起') : button('play','播放')}<a class="media-button" href="${escape(this.variant(url,'download','1'))}" target="_blank" rel="noreferrer">下载</a>${item.loading ? '<span role="status">正在加载…</span>' : ''}</span>${item.error ? `<span class="media-error" role="status">${escape(item.error)}</span>` : ''}${content}</span>`;
  }

  variant(url,name,value) {
    const parsed=new URL(url,'http://localhost');parsed.searchParams.set(name,value);
    return /^https?:\/\//i.test(url) ? url : parsed.pathname+parsed.search;
  }

  itemFor(key,kind) {
    let item=this.items.get(key);
    if(!item){
      let session,ref;try{[session,ref]=JSON.parse(decodeURIComponent(key));}catch{return;}
      if(session!==this.sessionId() || typeof ref!=='string')return;
      const url=this.path(ref);kind=mediaKind(ref) || kind;if(!url || !kind)return;
      item={key,ref,url,kind,session,mode:null,generation:0};this.items.set(key,item);
      while(this.items.size>this.maxEntries)this.items.delete(this.items.keys().next().value);
    }
    return item;
  }

  async activate(key,action,container) {
    const item=this.itemFor(key,container?.dataset.mediaKind);if(!item)return;
    item.generation++;const generation=item.generation;
    if(item.kind==='image' && action==='preview'){item.error=null;this.onChange();return;}
    if(action==='close') {
      const player=container?.querySelector('[data-media-player]');
      if(player){player.pause();player.removeAttribute('src');player.load();}
      item.mode=null;item.loading=false;item.error=null;this.onChange();return;
    }
    if(action!=='play')return;
    item.loading=true;item.error=null;this.onChange();
    try {
      const external=/^https?:\/\//i.test(item.url);
      if(!external)item.info=await this.request(this.variant(item.url,'info','1'));
      if(generation!==item.generation)return;
      if(this.sessionId()!==item.session){item.loading=false;item.mode=null;return;}
      item.mode='play';item.loading=false;this.onChange();
      if(item.mode==='play') {
        const player=container?.querySelector('[data-media-player]');
        if(player)await player.play().catch(()=>{});
      }
    } catch(error){if(generation===item.generation){item.loading=false;item.mode=null;item.error=error.message || '附件加载失败，可重试。';this.onChange();}}
  }

  bind(container) {
    for(const image of container.querySelectorAll('[data-media-image]')) {
      image.onerror=()=>{
        const card=image.closest('[data-media-key]');
        const item=this.itemFor(card.dataset.mediaKey,'image');
        if(item){item.mode=null;item.error='可重试缩略图，或直接打开原图。';}
        // Update just this card: a page full of missing files must not trigger
        // repeated whole-timeline renders as bounded failure entries expire.
        image.hidden=true;
        for(const fallback of card.querySelectorAll('[data-media-image-failure]'))fallback.hidden=false;
      };
      if(image.complete && image.naturalWidth===0 && image.getAttribute('src'))image.onerror();
    }
    for(const player of container.querySelectorAll('[data-media-player]'))player.onerror=()=>{
      const item=this.items.get(player.closest('[data-media-key]').dataset.mediaKey);
      if(item){item.mode=null;item.error='播放失败，可重试或下载文件。';this.onChange();}
    };
  }
}
