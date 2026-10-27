import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { isIP } from 'node:net';

const cookieName = 'codex_relay_browser';
const sessionSeconds = 14 * 24 * 60 * 60;
const localAddress = value => { const address=String(value).replace(/^::ffff:/i,''); return address === '::1' || isIP(address) === 4 && address.startsWith('127.'); };
const requestHost = req => { try { return new URL(`http://${req.headers?.host}`).hostname.replace(/^\[|\]$/g,''); } catch { return ''; } };
export const isLocalBrowser = req => localAddress(req.socket.remoteAddress)
  && (localAddress(requestHost(req)) || requestHost(req) === 'localhost')
  && !Object.keys(req.headers || {}).some(key => /^(?:forwarded$|x-forwarded-|tailscale-)/i.test(key));

export function privateOrigin(value) {
  if (!value) return '';
  const url = new URL(value);
  if (url.protocol !== 'https:' || !/^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$/.test(url.hostname)
    || url.port && url.port !== '8443' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('外网入口必须是本机 Tailscale 的 HTTPS 地址。');
  }
  return url.origin;
}

export function lanAddresses() {
  return [...new Set(Object.values(os.networkInterfaces()).flat().filter(item => item && !item.internal
    && item.family === 'IPv4' && /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(item.address)).map(item => item.address))];
}

export class BrowserAccess {
  constructor(dataDir, { now = Date.now, addresses = lanAddresses } = {}) {
    this.dataDir = dataDir; this.now = now; this.addresses = addresses;
    this.attempts = new Map(); this.pairing = null; this.key = null;
    this.registryPath = path.join(dataDir,'browser-devices.json');
    this.registry = {version:1,acceptLegacy:true,devices:[]};
    try {
      const data=JSON.parse(fs.readFileSync(this.registryPath,'utf8'));
      if(data.version!==1 || typeof data.acceptLegacy!=='boolean' || !Array.isArray(data.devices)
        || data.devices.some(device=>!device.id || !/^[a-f0-9]{64}$/.test(device.tokenHash) || !Number.isFinite(device.expiresAt))) throw new Error('设备授权记录无效');
      this.registry=data;
    } catch(error) { if(error.code!=='ENOENT') throw error; }
  }

  networkSettings() {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dataDir,'network.json'),'utf8'));
    } catch { return {}; }
  }

  externalOrigin() {
    try { return privateOrigin(process.env.CODEX_RELAY_EXTERNAL_URL || this.networkSettings().externalOrigin); } catch { return ''; }
  }

  privateOrigin() {
    try { return privateOrigin(this.networkSettings().privateOrigin); } catch { return ''; }
  }

  proxyOrigin(req) {
    return [this.externalOrigin(),this.privateOrigin()].find(origin=>origin && new URL(origin).host===req.headers.host) || '';
  }

  secureRequest(req) {
    const external = this.proxyOrigin(req);
    return Boolean(req.socket.encrypted || external && localAddress(req.socket.remoteAddress)
      && req.headers['x-forwarded-proto'] === 'https');
  }

  sameOrigin(req) {
    let url;
    try { url = new URL(`http://${req.headers.host}`); } catch { return false; }
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const fromPrivateProxy = Boolean(this.proxyOrigin(req));
    if (fromPrivateProxy && !this.secureRequest(req)) return false;
    if (!fromPrivateProxy && !localAddress(hostname) && hostname !== 'localhost' && !this.addresses().includes(hostname)) return false;
    if (req.headers['sec-fetch-site'] === 'cross-site') return false;
    if (!req.headers.origin) return true;
    try { const origin = new URL(req.headers.origin); return origin.host === url.host && origin.protocol === (this.secureRequest(req) ? 'https:' : 'http:'); } catch { return false; }
  }

  signingKey() {
    if (this.key) return this.key;
    fs.mkdirSync(this.dataDir, { recursive:true });
    const file = path.join(this.dataDir, 'browser-access-key');
    try { this.key = fs.readFileSync(file); }
    catch {
      const key = crypto.randomBytes(32);
      try { fs.writeFileSync(file, key, { flag:'wx', mode:0o600 }); this.key = key; }
      catch (error) { if (error.code !== 'EEXIST') throw error; this.key = fs.readFileSync(file); }
    }
    if (this.key.length !== 32) throw new Error('手机连接密钥无效');
    return this.key;
  }

  saveRegistry() {
    fs.mkdirSync(this.dataDir,{recursive:true});
    fs.writeFileSync(this.registryPath+'.tmp',JSON.stringify(this.registry),{mode:0o600});
    fs.renameSync(this.registryPath+'.tmp',this.registryPath);
  }

  addDevice(req, payload, name, expiresAt) {
    const ua=String(req.headers['user-agent'] || '');
    const platform=/iPhone/i.test(ua) ? 'iPhone' : /iPad/i.test(ua) ? 'iPad' : /Harmony/i.test(ua) ? '鸿蒙手机' : /Android/i.test(ua) ? '安卓/鸿蒙手机' : /Windows/i.test(ua) ? 'Windows 电脑' : /Macintosh/i.test(ua) ? 'Mac' : '浏览器';
    const browser=/Edg/i.test(ua) ? 'Edge' : /Firefox/i.test(ua) ? 'Firefox' : /Chrome|CriOS/i.test(ua) ? 'Chrome' : /Safari/i.test(ua) ? 'Safari' : '';
    const device={id:crypto.randomUUID(),tokenHash:crypto.createHash('sha256').update(payload).digest('hex'),
      name:String(name || `${platform}${browser ? ' · '+browser : ''}`).trim().slice(0,80),platform,browser,
      createdAt:this.now(),lastSeen:this.now(),expiresAt,revokedAt:null};
    this.registry.devices.push(device);this.saveRegistry();return device;
  }

  deviceFor(req,{touch=true}={}) {
    const token = String(req.headers.cookie || '').split(';').map(item => item.trim()).find(item => item.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
    if (!token || token.length > 256) return null;
    const parts = token.split('.');
    if (parts.length !== 3 || !/^\d+$/.test(parts[0]) || Number(parts[0]) <= this.now() || !/^(?:v2_)?[a-zA-Z0-9_-]{22}$/.test(parts[1])) return null;
    const payload=parts.slice(0,2).join('.');
    const expected = crypto.createHmac('sha256', this.signingKey()).update(payload).digest('base64url');
    const actual = Buffer.from(parts[2]); const wanted = Buffer.from(expected);
    if(actual.length!==wanted.length || !crypto.timingSafeEqual(actual,wanted))return null;
    const hash=crypto.createHash('sha256').update(payload).digest('hex');
    let device=this.registry.devices.find(device=>device.tokenHash===hash);
    // Existing LAN cookies migrate on use; new cookies must already have a saved grant.
    if(!device && this.registry.acceptLegacy && !parts[1].startsWith('v2_'))device=this.addDevice(req,payload,null,Number(parts[0]));
    if(!device || device.revokedAt!=null || device.expiresAt<=this.now())return null;
    if(touch && this.now()-device.lastSeen>=60_000){device.lastSeen=this.now();this.saveRegistry();}
    return device;
  }

  authorized(req,options) { return isLocalBrowser(req) || Boolean(this.deviceFor(req,options)); }

  listDevices() {
    return this.registry.devices.map(({tokenHash,...device})=>({...device,status:device.revokedAt!=null ? 'revoked' : device.expiresAt<=this.now() ? 'expired' : 'authorized'})).sort((a,b)=>b.createdAt-a.createdAt);
  }

  renameDevice(id,name) {
    if(typeof name!=='string' || !name.trim() || name.trim().length>80)throw new Error('设备名称需要 1–80 个字符。');
    const device=this.registry.devices.find(device=>device.id===id);
    if(!device)return false;
    device.name=name.trim();this.saveRegistry();return true;
  }

  revokeDevice(id) {
    const device=this.registry.devices.find(device=>device.id===id);
    if(!device)return false;
    device.revokedAt=this.now();this.saveRegistry();return true;
  }

  revokeAll() {
    for(const device of this.registry.devices)device.revokedAt ??=this.now();
    this.registry.acceptLegacy=false;this.pairing=null;this.saveRegistry();
  }

  pairingInfo(port, enabled, {rotate=false}={}) {
    if(rotate)this.pairing=null;
    if (!this.pairing || this.pairing.expiresAt <= this.now()) this.pairing = {
      code:crypto.randomInt(0,100_000_000).toString().padStart(8,'0'), expiresAt:this.now()+10*60*1000
    };
    const externalOrigin = this.externalOrigin();
    const privateOrigin=this.privateOrigin();
    const accessMode=this.networkSettings().accessMode==='hybrid' ? 'hybrid' : 'private';
    return { enabled:enabled || Boolean(externalOrigin), externalUrl:externalOrigin ? externalOrigin+'/' : '',
      privateUrl:privateOrigin ? privateOrigin+'/' : '',publicUrl:accessMode==='hybrid' && externalOrigin ? externalOrigin+'/' : '',accessMode,
      urls:enabled ? this.addresses().map(address=>`http://${address}:${port}/`) : [], ...this.pairing };
  }

  pair(req, value, name) {
    const now = this.now(); const peer = req.socket.remoteAddress;
    for (const [key, attempt] of this.attempts) if (attempt.resetAt <= now) this.attempts.delete(key);
    const attempt = this.attempts.get(peer) || { count:0, resetAt:now+60_000 };
    const global = this.attempts.get('*') || { count:0, resetAt:now+60_000 };
    if (attempt.count >= 5 || global.count >= 60) return { status:429, error:'尝试次数过多，请稍后再试。' };
    attempt.count++; global.count++; this.attempts.set(peer,attempt); this.attempts.set('*',global);
    const code = String(value || '').replace(/\s/g,'');
    if (!this.pairing || this.pairing.expiresAt <= now || code !== this.pairing.code) return { status:401, error:'配对码不正确或已过期，请查看电脑上的配对码。' };
    const payload = `${now+sessionSeconds*1000}.v2_${crypto.randomBytes(16).toString('base64url')}`;
    this.addDevice(req,payload,name,now+sessionSeconds*1000);
    this.pairing = null; this.attempts.delete(peer);
    const signature = crypto.createHmac('sha256',this.signingKey()).update(payload).digest('base64url');
    return { status:200, cookie:`${cookieName}=${payload}.${signature}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${sessionSeconds}${this.secureRequest(req) ? '; Secure' : ''}` };
  }
}
