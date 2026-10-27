import fs from 'node:fs';
import path from 'node:path';
import {createHash}from'node:crypto';
import {hostname}from'node:os';
import {resolveAppIcon}from'../public/app-icon-themes.js';
export const applicationIconStyle=(computerName,choice='auto')=>resolveAppIcon(computerName,choice,hostname()).id;

export function applicationIcon(publicDir,computerName,choice='auto',machine=hostname()){
  const icon=resolveAppIcon(computerName,choice,machine);
  const digest=createHash('sha256').update(icon.id);
  for(const suffix of ['192.png','512.png','icon.svg'])digest.update(fs.readFileSync(path.join(publicDir,`app-icon-${icon.id}-${suffix}`)));
  const version=digest.digest('hex').slice(0,16),url=suffix=>`/app-icon-${icon.id}-${suffix}?v=${version}`;
  return {...icon,version,small:url('192.png'),large:url('512.png'),svg:url('icon.svg')};
}

export function applicationManifest(publicDir,computerName,choice='auto'){
  const manifest=JSON.parse(fs.readFileSync(path.join(publicDir,'manifest.webmanifest'),'utf8'));
  const name='Codex · '+(typeof computerName==='string'&&computerName.trim()?computerName.trim():hostname());
  const icon=applicationIcon(publicDir,computerName,choice);
  // The name can change without creating a second installation for this origin.
  return {...manifest,name,short_name:name,icons:[{src:icon.small,sizes:'192x192',type:'image/png',purpose:'any maskable'},{src:icon.large,sizes:'512x512',type:'image/png',purpose:'any maskable'}]};
}

// Give installed applications a new shell revision whenever public assets
// change, even when only frontend files were updated without a Relay restart.
export function applicationWorker(publicDir,identity='',iconUrl='/app-icon-192.png'){
  let source=fs.readFileSync(path.join(publicDir,'notification-worker.js'),'utf8');
  source=source.replace(/const APP_NOTIFICATION_ICON=[^;]+;/,'const APP_NOTIFICATION_ICON='+JSON.stringify(iconUrl)+';');
  const assets=['/index.html','/styles.css','/app-icon.svg','/app-icon-192.png','/app-icon-512.png',
    ...fs.readdirSync(publicDir).filter(name=>name.endsWith('.js')&&name!=='notification-worker.js').map(name=>'/'+name)];
  source=source.replace(/const SHELL_ASSETS=\[[^;]+\];/,'const SHELL_ASSETS='+JSON.stringify(assets)+';');
  const hash=createHash('sha256').update(source).update(identity);
  for(const asset of assets)hash.update(fs.readFileSync(path.join(publicDir,asset)));
  return source.replace(/codex-relay-shell-[a-f0-9]+/,'codex-relay-shell-'+hash.digest('hex').slice(0,16));
}
