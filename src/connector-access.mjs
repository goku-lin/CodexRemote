import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const hash=value=>crypto.createHash('sha256').update(String(value)).digest('hex');
export class ConnectorAccess {
  constructor(directory,secret,{now=Date.now}={}){
    this.file=path.join(directory,'connector-devices.json');this.secret=secret;this.now=now;this.attempts=new Map();
    this.data={devices:[],codes:[]};
    try{this.data=JSON.parse(fs.readFileSync(this.file,'utf8'));if(!Array.isArray(this.data.devices) || !Array.isArray(this.data.codes) || this.data.devices.some(device=>!/^pc-[a-f0-9-]{36}$/.test(device.id) || !/^[a-f0-9]{64}$/.test(device.tokenHash)))throw new Error('电脑授权记录无效');}catch(error){if(error.code!=='ENOENT')throw error;}
  }
  save(){fs.mkdirSync(path.dirname(this.file),{recursive:true});fs.writeFileSync(this.file+'.tmp',JSON.stringify(this.data),{mode:0o600});fs.renameSync(this.file+'.tmp',this.file);}
  code(){
    const code=crypto.randomInt(0,100_000_000).toString().padStart(8,'0'),expiresAt=this.now()+600_000;
    this.data.codes=this.data.codes.filter(item=>item.expiresAt>this.now()).slice(-19);
    this.data.codes.push({hash:hash(code),expiresAt});this.save();return {code,expiresAt};
  }
  token(device){return crypto.createHmac('sha256',this.secret).update(device.id+'\0'+device.nonce).digest('hex');}
  enroll({code,nonce,name},peer){
    if(!/^[a-f0-9-]{36}$/.test(nonce || '') || typeof name!=='string' || !name.trim() || name.length>80)throw new Error('安装信息无效');
    const now=this.now();for(const [key,value] of this.attempts)if(value.until<=now)this.attempts.delete(key);
    const attempt=this.attempts.get(peer) || {count:0,until:now+60_000};
    if(attempt.count>=8)throw Object.assign(new Error('连接码尝试过多，请稍后重试'),{status:429});
    attempt.count++;if(this.attempts.size<1000 || this.attempts.has(peer))this.attempts.set(peer,attempt);
    const entry=/^\d{8}$/.test(String(code)) && this.data.codes.find(item=>item.hash===hash(code) && item.expiresAt>now);
    if(!entry)throw new Error('连接码无效或已过期，请在主电脑重新生成');
    if(entry.deviceId){
      const old=this.data.devices.find(item=>item.id===entry.deviceId && item.nonce===nonce && !item.revokedAt);
      if(!old)throw new Error('连接码已经用于另一台电脑');
      this.attempts.delete(peer);return {id:old.id,name:old.name,token:this.token(old)};
    }
    const device={id:'pc-'+crypto.randomUUID(),nonce,name:name.trim(),createdAt:now,revokedAt:null};
    device.tokenHash=hash(this.token(device));entry.deviceId=device.id;this.data.devices.push(device);this.save();
    this.attempts.delete(peer);return {id:device.id,name:device.name,token:this.token(device)};
  }
  authorized(id,token){
    if(typeof token!=='string' || token.length!==64)return false;
    const device=this.data.devices.find(item=>item.id===id && !item.revokedAt);
    return Boolean(device && crypto.timingSafeEqual(Buffer.from(hash(token)),Buffer.from(device.tokenHash)));
  }
  list(){return this.data.devices.map(({tokenHash,nonce,...item})=>item);}
  revoke(id){const device=this.data.devices.find(item=>item.id===id);if(!device)return false;device.revokedAt=this.now() || 1;this.save();return true;}
}
