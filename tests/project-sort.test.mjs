import test from 'node:test';
import assert from 'node:assert/strict';
import {ProjectSorter} from '../public/project-sort.js';
import {ProjectManagement} from '../public/project-management.js';
import {ProjectOrder} from '../public/project-order.js';

const classes=()=>({values:new Set(),add(value){this.values.add(value);},remove(value){this.values.delete(value);},contains(value){return this.values.has(value);}});
function fixture(t,{count=3,height=192,holdMs=8}={}) {
  const committed=new ProjectOrder(),projects=Array.from({length:count},(_,i)=>({id:String.fromCharCode(97+i),deviceId:'local'}));
  committed.arrange(projects);const draft=new ProjectManagement(projects,committed,'local'),moves=[],busy=[],frames=new Map();let serial=0,scrollTop=0;
  const container={children:[],classList:classes(),capture:null,
    querySelectorAll:()=>container.children.slice(),contains:node=>container.children.includes(node.row || node),
    getBoundingClientRect:()=>({top:0,bottom:height,height}),
    get scrollTop(){return scrollTop;},set scrollTop(value){scrollTop=Math.max(0,Math.min(count*64-height,value));},
    setPointerCapture(id){this.capture=id;},hasPointerCapture(id){return this.capture===id;},releasePointerCapture(){this.capture=null;},
    insertBefore(row,before){this.children.splice(this.children.indexOf(row),1);const index=before ? this.children.indexOf(before) : this.children.length;this.children.splice(index,0,row);}
  };
  const handles=projects.map(project=>{
    const row={dataset:{projectRow:project.id},classList:classes(),getBoundingClientRect:()=>({top:container.children.indexOf(row)*64-container.scrollTop,height:64})};
    const handle={row,dataset:{projectDrag:project.id},focus(){},closest:selector=>selector==='[data-project-drag]' ? handle : selector==='[data-project-row]' ? row : null};
    container.children.push(row);return handle;
  });
  const sorter=new ProjectSorter({container,holdMs,onBusy:value=>busy.push(value),
    frame:callback=>{frames.set(++serial,callback);return serial;},cancelFrame:id=>frames.delete(id),
    onMove:(id,index)=>{moves.push([id,index]);draft.move(id,index);}});
  t.after(()=>sorter.cancel());
  const event=(index,y,extra={})=>({target:handles[index],pointerId:1,pointerType:'mouse',button:0,clientY:y,preventDefault(){this.prevented=true;},stopPropagation(){this.stopped=true;},...extra});
  const ids=()=>container.children.map(row=>row.dataset.projectRow);
  return {container,sorter,handles,event,ids,moves,busy,draft,committed,projects,frames,
    frame(){const [id,callback]=frames.entries().next().value;frames.delete(id);callback();}};
}

test('mouse handle dragging previews a new order, drops into the management draft and leaves the saved sidebar unchanged',t=>{
  const f=fixture(t);
  f.draft.setEnabled('b',false);
  f.container.onpointerdown(f.event(2,160));f.container.onpointermove(f.event(2,8));
  assert.deepEqual(f.ids(),['c','a','b']);assert.equal(f.container.capture,1);
  assert.deepEqual(f.moves,[],'pointer movement is a cancellable preview');
  f.container.onpointerup(f.event(2,8));
  assert.deepEqual(f.moves,[['c',0]]);assert.deepEqual(f.busy,[true,false]);assert.equal(f.container.capture,null);assert.equal(f.frames.size,0);
  assert.deepEqual(f.draft.rows().map(row=>row.id),['c','a','b']);assert.deepEqual(f.draft.hiddenProjects(),['b']);
  assert.deepEqual(f.committed.arrange(f.projects).map(row=>row.id),['a','b','c']);
  f.draft.commit(f.committed);assert.deepEqual(f.committed.arrange(f.projects).map(row=>row.id),['c','a','b']);
});

test('cancelled pointers and Escape restore the original order without committing a partial drag',t=>{
  const f=fixture(t);
  for(const cancel of ['pointercancel','Escape']){
    f.container.onpointerdown(f.event(0,30));f.container.onpointermove(f.event(0,185));assert.deepEqual(f.ids(),['b','c','a']);
    if(cancel==='Escape')f.container.onkeydown(f.event(0,185,{key:'Escape'}));else f.container.onpointercancel(f.event(0,185));
    assert.deepEqual(f.ids(),['a','b','c']);assert.equal(f.frames.size,0);
  }
  assert.deepEqual(f.moves,[]);
});

test('touch requires a hold on the handle, ignores quick taps/swipes and keeps checkboxes available',async t=>{
  const f=fixture(t),touch={pointerType:'touch'};
  f.container.onpointerdown(f.event(0,30,touch));f.container.onpointerup(f.event(0,30,touch));
  await new Promise(resolve=>setTimeout(resolve,15));assert.deepEqual(f.busy,[]);
  f.container.onpointerdown(f.event(0,30,touch));f.container.onpointermove(f.event(0,45,touch));
  await new Promise(resolve=>setTimeout(resolve,15));assert.equal(f.sorter.drag,null);assert.deepEqual(f.moves,[]);
  f.container.onpointerdown(f.event(0,30,{target:{closest:()=>null}}));assert.equal(f.sorter.drag,null);
  f.container.onpointerdown(f.event(0,30,touch));await new Promise(resolve=>setTimeout(resolve,15));
  assert.equal(f.sorter.drag.active,true);f.container.onpointermove(f.event(0,185,touch));f.container.onpointerup(f.event(0,185,touch));
  assert.deepEqual(f.moves,[['a',2]]);
});

test('long lists scroll while a held drag approaches the edge and stop scrolling on release',t=>{
  const f=fixture(t,{count:10,height:192});
  f.container.onpointerdown(f.event(0,30));f.container.onpointermove(f.event(0,186));
  const first=f.container.scrollTop;assert.ok(first>0);f.frame();assert.ok(f.container.scrollTop>first);
  f.container.onpointerup(f.event(0,186));assert.equal(f.frames.size,0);assert.equal(f.sorter.drag,null);
});

test('keyboard ordering uses the same draft callback, respects bounds and is disabled during Save',t=>{
  const f=fixture(t);
  f.container.onkeydown(f.event(0,0,{key:'ArrowUp'}));assert.deepEqual(f.moves,[]);
  f.container.onkeydown(f.event(2,0,{key:'Home'}));assert.deepEqual(f.moves,[['c',0]]);
  f.sorter.canStart=()=>false;f.container.onpointerdown(f.event(0,30));assert.equal(f.sorter.drag,null);
  f.container.onkeydown(f.event(0,0,{key:'End'}));assert.equal(f.moves.length,1);
});
