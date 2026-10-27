import {requestId} from './reliability.js';
import {LocalImages} from './local-images.js';

const newUploadId=()=>{const id=requestId();return `${id.slice(0,8)}-${id.slice(8,12)}-${id.slice(12,16)}-${id.slice(16,20)}-${id.slice(20)}`;};
const readImage=async file=>{
  const dataUrl=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('图片读取失败，请重新选择。'));reader.readAsDataURL(file);});
  const preview=new Image();preview.src=dataUrl;
  try{await preview.decode();}catch{throw new Error('这张图片无法在本机读取，请重新选择有效的图片。');}
  finally{preview.src='';}
  return dataUrl;
};

// Persist only the upload identifier, never a large data URL in localStorage.
// A lost POST response is reconciled by identifier before adding an attachment.
export class ImageUploads {
  constructor({api,drafts,onChange=()=>{},read=readImage,newId=newUploadId,files=new LocalImages()}){
    Object.assign(this,{api,drafts,onChange,read,newId,files});this.tasks=new Map();
    for(const [scope,draft] of Object.entries(drafts.items))for(const job of draft.uploadJobs || []){
      if(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(job.id))this.tasks.set(job.id,{...job,scope,state:job.localOnly ? 'loading' : 'checking'});
    }
  }
  list(scope){return [...this.tasks.values()].filter(task=>task.scope===scope);}
  get busy(){return [...this.tasks.values()].filter(task=>task.running).length;}
  persist(scope){const draft=this.drafts.get(scope);this.drafts.set(scope,{...draft,uploadJobs:this.list(scope).map(({id,name,localOnly,deviceId})=>({id,name,localOnly,deviceId}))});}
  changed(scope){this.onChange(scope);}
  remove(id){const task=this.tasks.get(id);if(!task)return;this.tasks.delete(id);this.files.delete(id);this.persist(task.scope);this.changed(task.scope);}
  complete(task,image){
    if(!this.tasks.has(task.id))return;
    const draft=this.drafts.get(task.scope),attachments=draft.attachments || [];
    if(!attachments.some(value=>value.id===image.id))attachments.push(image);
    this.drafts.set(task.scope,{...draft,attachments});this.remove(task.id);
  }
  async lookup(task){const result=await this.api(`/api/uploads/${task.id}/status`,{deviceId:task.deviceId,timeoutMs:10000,networkMessage:'图片上传结果暂时无法核对，请恢复连接后再检查。'});return result.found ? result.image : null;}
  async add(scope,file,deviceId){
    if((this.drafts.get(scope).attachments?.length || 0)+this.list(scope).length>=5)throw new Error('每次最多添加 5 张图片。');
    if(!['image/png','image/jpeg','image/webp','image/gif'].includes(file.type) || file.size>10*1024*1024)throw new Error('支持 PNG、JPEG、WebP、GIF，每张最多 10 MB。');
    const task={id:this.newId(),name:file.name || '图片',scope,file,deviceId,state:'loading',localOnly:true,running:true};
    this.tasks.set(task.id,task);this.persist(scope);this.changed(scope);
    try{task.dataUrl=await this.read(file);await this.files.put(task.id,file);task.state='selected';}
    catch(error){task.state='error';task.error=error.message;}
    finally{task.running=false;this.changed(scope);}
  }
  async upload(scope,ids=this.list(scope).map(task=>task.id)){
    for(const id of ids){await this.retry(id);if(this.tasks.has(id))throw new Error(this.tasks.get(id).error || '图片尚未上传完成，消息尚未发送。');}
  }
  async retry(id){
    const task=this.tasks.get(id);if(!task || task.running)return;
    task.running=true;task.state='uploading';task.error=null;this.changed(task.scope);
    try{
      if(!task.file && !task.dataUrl)task.file=await this.files.get(task.id);
      if(!task.file && !task.dataUrl)throw new Error('图片草稿无法读取，请移除这项后重新选择图片。');
      task.dataUrl ||= await this.read(task.file);
      task.localOnly=false;this.persist(task.scope);
      let image;
      try{
        image=await this.api('/api/uploads',{deviceId:task.deviceId,method:'POST',timeoutMs:120000,networkMessage:'图片上传连接中断，正在核对结果。',body:JSON.stringify({requestId:task.id,name:task.name,dataUrl:task.dataUrl})});
        if(image.id!==task.id)throw new Error('图片上传确认不完整');
      }catch(error){
        if(error.status && error.status<500)throw error;
        task.state='checking';this.changed(task.scope);
        image=await this.lookup(task);
        if(!image)throw new Error('图片尚未上传完成，尚未发送给 Codex。请重试；文字已保留。');
      }
      this.complete(task,image);
    }catch(error){task.state='error';task.error=error.message;this.changed(task.scope);}
    finally{task.running=false;this.changed(task.scope);}
  }
  async reconcile(){
    for(const task of [...this.tasks.values()]){
      if(task.running || task.localOnly && task.dataUrl)continue;
      task.running=true;task.state='checking';this.changed(task.scope);
      try{
        const image=task.localOnly ? null : await this.lookup(task);
        if(image)this.complete(task,image);
        else{
          task.file ||= await this.files.get(task.id);
          if(!task.dataUrl && task.file)task.dataUrl=await this.read(task.file);
          task.state=task.dataUrl ? 'selected' : 'error';task.error=task.dataUrl ? null : '图片草稿无法读取，请移除这项后重新选择图片。';
        }
      }
      catch(error){task.state='error';task.error=error.message;}
      finally{task.running=false;this.changed(task.scope);}
    }
  }
}
