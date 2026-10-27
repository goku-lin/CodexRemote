import fs from 'node:fs';
import path from 'node:path';
import {randomBytes,scrypt,timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';

const derive=promisify(scrypt);
export function writePrivateJson(file,value){
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const temporary=file+'.'+process.pid+'.tmp';
  fs.writeFileSync(temporary,JSON.stringify(value),{mode:0o600});fs.renameSync(temporary,file);
}
function credential(file){
  try{
    const value=JSON.parse(fs.readFileSync(file,'utf8'));
    if(value.version!==1 || !/^[a-f0-9]{32}$/.test(value.salt) || !/^[a-f0-9]{64}$/.test(value.hash))throw new Error();
    return value;
  }catch(error){if(error.code==='ENOENT')return null;throw new Error('重启密码配置无效，请在电脑本机重新设置。');}
}
export async function setMaintenancePassword(dataDir,password){
  if(typeof password!=='string' || password.length<6 || password.length>128)throw new Error('重启密码需要 6–128 个字符。');
  const salt=randomBytes(16).toString('hex'),hash=(await derive(password,salt,32)).toString('hex');
  writePrivateJson(path.join(dataDir,'maintenance-password.json'),{version:1,salt,hash});
}
export class MaintenanceAuth {
  constructor(dataDir,{now=Date.now}={}){this.file=path.join(dataDir,'maintenance-password.json');this.now=now;this.failures=0;this.blockedUntil=0;this.busy=false;}
  configured(){return Boolean(credential(this.file));}
  async verify(password){
    const saved=credential(this.file);if(!saved)throw new Error('请先在 Codex 电脑本机设置重启密码。');
    const signature=saved.salt+saved.hash;
    if(signature!==this.signature){this.signature=signature;this.failures=0;this.blockedUntil=0;}
    if(this.now()<this.blockedUntil){const error=new Error('密码错误次数过多，请稍后再试。');error.status=429;throw error;}
    if(this.busy){const error=new Error('正在校验密码，请稍后再试。');error.status=429;throw error;}
    this.busy=true;
    try{
      const valid=typeof password==='string' && password.length>=6 && password.length<=128;
      const actual=await derive(valid?password:'invalid-maintenance-password',saved.salt,32);
      if(credential(this.file)?.hash!==saved.hash){const error=new Error('本机重启密码已更改，请重新输入。');error.status=409;throw error;}
      if(!valid || !timingSafeEqual(actual,Buffer.from(saved.hash,'hex'))){
        if(++this.failures>=5){this.blockedUntil=this.now()+60_000;this.failures=0;}
        const error=new Error('重启密码不正确。');error.status=403;throw error;
      }
      this.failures=0;
    }finally{this.busy=false;}
  }
}
