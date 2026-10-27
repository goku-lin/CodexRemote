const storageKey='codex-relay-project-order';

export class ProjectOrder {
  constructor(storage) {
    this.storage=storage;this.devices=new Map();
    try {
      const saved=JSON.parse(storage?.getItem(storageKey) || '{}');
      for(const [device,ids] of Object.entries(saved))if(Array.isArray(ids))this.devices.set(device,[...new Set(ids.filter(id=>typeof id==='string'))]);
    } catch { /* Invalid or unavailable storage keeps a stable order in memory. */ }
  }
  save() {
    try { this.storage?.setItem(storageKey,JSON.stringify(Object.fromEntries(this.devices))); } catch {}
  }
  arrange(projects,device='local') {
    const saved=this.devices.get(device) || [],known=new Set(saved);
    const added=projects.filter(project=>!known.has(project.id)).map(project=>project.id);
    if(added.length){saved.push(...added);this.devices.set(device,saved);this.save();}
    const positions=new Map(saved.map((id,index)=>[id,index]));
    return projects.slice().sort((a,b)=>positions.get(a.id)-positions.get(b.id));
  }
  move(projects,id,index,device='local') {
    const visible=this.arrange(projects,device).map(project=>project.id),from=visible.indexOf(id);
    if(from<0 || !Number.isInteger(index) || index<0 || index>=visible.length || index===from)return false;
    visible.splice(from,1);visible.splice(index,0,id);
    const visibleIds=new Set(visible);let next=0;
    // Hidden projects keep their saved slots so restoring them does not reset order.
    this.devices.set(device,this.devices.get(device).map(id=>visibleIds.has(id) ? visible[next++] : id));
    this.save();return true;
  }
}
