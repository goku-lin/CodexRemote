export class ProjectSorter {
  constructor({container,onMove,onBusy=()=>{},canStart=()=>true,holdMs=220,
    frame=callback=>setTimeout(callback,16),cancelFrame=clearTimeout}) {
    Object.assign(this,{container,onMove,onBusy,canStart,holdMs,frame,cancelFrame});
    this.drag=null;this.scrollFrame=null;
    container.onpointerdown=event=>this.down(event);
    container.onpointermove=event=>this.move(event);
    container.onpointerup=event=>{if(event.pointerId===this.drag?.pointerId)this.finish();};
    container.onpointercancel=container.onlostpointercapture=event=>{if(event.pointerId===this.drag?.pointerId)this.cancel();};
    container.onkeydown=event=>this.key(event);
    container.oncontextmenu=event=>{if(event.target.closest('[data-project-drag]'))event.preventDefault();};
    this.page=container.ownerDocument;
    this.onVisibility=()=>{if(this.page.hidden)this.cancel();};
    this.page?.addEventListener('visibilitychange',this.onVisibility);
  }
  rows(){return [...this.container.querySelectorAll('[data-project-row]')];}
  down(event) {
    const handle=event.target.closest('[data-project-drag]');
    if(!handle || this.drag || event.button!==0 || !this.canStart() || !this.container.contains(handle))return;
    const row=handle.closest('[data-project-row]'),index=this.rows().indexOf(row);if(index<0)return;
    event.preventDefault();handle.focus({preventScroll:true});
    this.drag={pointerId:event.pointerId,id:handle.dataset.projectDrag,row,handle,index,original:index,y:event.clientY,startY:event.clientY,active:false,touch:event.pointerType==='touch'};
    this.container.setPointerCapture?.(event.pointerId);
    if(this.drag.touch)this.drag.timer=setTimeout(()=>this.start(),this.holdMs);
  }
  start() {
    const drag=this.drag;if(!drag || drag.active)return;
    if(!this.container.contains(drag.row)){this.cancel();return;}
    clearTimeout(drag.timer);drag.active=true;
    drag.row.classList.add('is-dragging');this.container.classList.add('is-sorting');
    this.onBusy(true);this.scroll();
  }
  move(event) {
    const drag=this.drag;if(event.pointerId!==drag?.pointerId)return;
    drag.y=event.clientY;
    if(!drag.active) {
      if(drag.touch){if(Math.abs(drag.y-drag.startY)>8)this.cancel();return;}
      if(Math.abs(drag.y-drag.startY)<4)return;
      this.start();
    }
    event.preventDefault();this.place(drag.y);
  }
  place(y) {
    const drag=this.drag;if(!drag?.active)return;
    const others=this.rows().filter(row=>row!==drag.row);
    let index=others.findIndex(row=>{const rect=row.getBoundingClientRect();return y<rect.top+rect.height/2;});
    if(index<0)index=others.length;
    if(index===drag.index)return;
    this.container.insertBefore(drag.row,others[index] || null);drag.index=index;
  }
  scroll() {
    const drag=this.drag;if(!drag?.active)return;
    const bounds=this.container.getBoundingClientRect(),margin=Math.min(40,bounds.height/4);
    const speed=drag.y<bounds.top+margin ? -Math.min(14,(bounds.top+margin-drag.y)/2)
      : drag.y>bounds.bottom-margin ? Math.min(14,(drag.y-bounds.bottom+margin)/2) : 0;
    if(speed){const previous=this.container.scrollTop;this.container.scrollTop+=speed;if(previous!==this.container.scrollTop)this.place(drag.y);}
    this.scrollFrame=this.frame(()=>this.scroll());
  }
  finish(cancelled=false) {
    const drag=this.drag;if(!drag)return;
    this.drag=null;clearTimeout(drag.timer);this.cancelFrame(this.scrollFrame);this.scrollFrame=null;
    drag.row.classList.remove('is-dragging');this.container.classList.remove('is-sorting');
    if(cancelled && drag.active){const others=this.rows().filter(row=>row!==drag.row);this.container.insertBefore(drag.row,others[drag.original] || null);}
    if(this.container.hasPointerCapture?.(drag.pointerId))this.container.releasePointerCapture(drag.pointerId);
    if(drag.active)this.onBusy(false);
    if(!cancelled && drag.active && drag.index!==drag.original)this.onMove(drag.id,drag.index);
  }
  cancel(){this.finish(true);}
  destroy(){this.cancel();this.page?.removeEventListener('visibilitychange',this.onVisibility);}
  key(event) {
    if(event.key==='Escape' && this.drag){event.preventDefault();event.stopPropagation();this.cancel();return;}
    const handle=event.target.closest('[data-project-drag]');if(!handle || !this.canStart() || this.drag)return;
    const rows=this.rows(),index=rows.findIndex(row=>row.dataset.projectRow===handle.dataset.projectDrag);
    const target={ArrowUp:index-1,ArrowDown:index+1,Home:0,End:rows.length-1}[event.key];
    if(target===undefined)return;
    event.preventDefault();event.stopPropagation();
    if(index>=0 && target>=0 && target<rows.length && index!==target)this.onMove(handle.dataset.projectDrag,target);
  }
}
