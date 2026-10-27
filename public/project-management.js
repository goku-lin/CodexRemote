import {ProjectOrder} from './project-order.js';

export class ProjectManagement {
  constructor(projects,order,deviceId) {
    this.projects=projects;this.deviceId=deviceId;
    this.enabled=new Set(projects.filter(project=>!project.hidden).map(project=>project.id));
    this.order=new ProjectOrder();
    this.order.devices=new Map([...order.devices].map(([device,ids])=>[device,ids.slice()]));
  }
  rows(){return this.order.arrange(this.projects.filter(project=>project.deviceId===this.deviceId),this.deviceId);}
  move(id,index){return this.order.move(this.rows(),id,index,this.deviceId);}
  setEnabled(id,enabled){if(enabled)this.enabled.add(id);else this.enabled.delete(id);}
  hiddenProjects(){return this.projects.filter(project=>!this.enabled.has(project.id)).map(project=>project.id);}
  commit(order){order.devices.set(this.deviceId,this.order.devices.get(this.deviceId)?.slice() || []);order.save();}
}
