// Image drafts stay on this device until Send is pressed. IndexedDB holds the
// original Blob so large images do not exhaust localStorage's text quota.
export class LocalImages {
  constructor(factory=typeof indexedDB==='undefined' ? null : indexedDB){this.factory=factory;}
  async database(){
    if(!this.factory)return null;
    this.opening ||= new Promise(resolve=>{
      const request=this.factory.open('codex-relay-image-drafts',1);
      request.onupgradeneeded=()=>request.result.createObjectStore('images');
      request.onsuccess=()=>resolve(request.result);request.onerror=()=>resolve(null);
      request.onblocked=()=>resolve(null);
    });
    return this.opening;
  }
  async request(mode,operation){
    try{
      const db=await this.database();if(!db)return;
      return await new Promise(resolve=>{
        const transaction=db.transaction('images',mode),request=operation(transaction.objectStore('images'));
        transaction.oncomplete=()=>resolve(request.result);transaction.onerror=transaction.onabort=()=>resolve(undefined);
      });
    }catch{/* keep the selected file in memory if browser storage is unavailable */}
  }
  put(id,file){return this.request('readwrite',store=>store.put(file,id));}
  get(id){return this.request('readonly',store=>store.get(id));}
  delete(id){return this.request('readwrite',store=>store.delete(id));}
}
