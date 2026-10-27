// Isolated real UI/media check; no Desktop or model requests are sent.
import {mkdtemp,rm,stat} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import os from 'node:os';
import {createMediaFixture} from './media-fixture.mjs';
const directory=await mkdtemp(path.join(os.tmpdir(),'relay-media-browser-'));
const image=path.join(directory,'示例图片.png'),audio=path.join(directory,'示例音频.mp3'),run=promisify(execFile);
const ffmpeg=process.env.CODEX_RELAY_FFMPEG || 'ffmpeg';
await run(ffmpeg,['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc=size=1800x1200:rate=1','-frames:v','1','-update','1',image],{windowsHide:true});
await run(ffmpeg,['-hide_banner','-loglevel','error','-f','lavfi','-i','sine=frequency=440:duration=240','-ac','1','-b:a','64k',audio],{windowsHide:true});
const fixture=await createMediaFixture({directory,files:[image,audio],proofPanel:true});
console.log(JSON.stringify({url:fixture.browserBase,imageBytes:(await stat(image)).size,audioBytes:(await stat(audio)).size}));
let closing=false;
async function close(){if(closing)return;closing=true;await fixture.close();if(path.dirname(path.resolve(directory))!==path.resolve(os.tmpdir()))throw new Error('Cleanup path');await rm(directory,{recursive:true,force:true});process.exit(0);}
process.stdin.on('data',close);process.on('SIGTERM',close);process.on('SIGINT',close);
