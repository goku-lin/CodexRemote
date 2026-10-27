import path from 'node:path';
import {fileURLToPath} from 'node:url';
import readline from 'node:readline';
import {projectRoot} from './layout.mjs';
import {setMaintenancePassword} from './maintenance-auth.mjs';

async function hiddenInput(prompt){
  if(!process.stdin.isTTY || !process.stdin.setRawMode)throw new Error('请在电脑本机终端运行此工具，不能从网页或管道设置密码。');
  process.stdout.write(prompt);readline.emitKeypressEvents(process.stdin);
  const wasRaw=Boolean(process.stdin.isRaw);process.stdin.setRawMode(true);process.stdin.resume();
  return new Promise((resolve,reject)=>{
    let value='';
    const finish=(error)=>{process.stdin.off('keypress',key);process.stdin.setRawMode(wasRaw);process.stdin.pause();process.stdout.write('\n');error?reject(error):resolve(value);};
    const key=(text,event={})=>{
      if(event.ctrl&&event.name==='c')return finish(new Error('已取消，密码没有修改。'));
      if(event.name==='return')return finish();
      if(event.name==='backspace'){value=Array.from(value).slice(0,-1).join('');return;}
      if(!event.ctrl && text && !/[\u0000-\u001f\u007f]/.test(text))value+=text;
    };
    process.stdin.on('keypress',key);
  });
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const flag=process.argv.indexOf('--data-dir'),dataDir=flag>=0?path.resolve(process.argv[flag+1]):process.env.CODEX_RELAY_DATA_DIR || path.join(projectRoot,'.relay-data');
    const password=await hiddenInput('设置重启密码（6–128 个字符，输入不显示）：');
    const confirmation=await hiddenInput('再次输入重启密码：');
    if(password!==confirmation)throw new Error('两次密码不一致，密码没有修改。');
    await setMaintenancePassword(dataDir,password);
    console.log('重启密码已在本机保存。网页刷新状态后生效，无需重启任何服务。');
  }catch(error){console.error(error.message);process.exitCode=1;}
}
