import {spawn} from 'node:child_process';

export function supervise(command,args,options,{onState=()=>{},minDelay=750,maxDelay=15_000,stableMs=30_000}={}) {
  let child,stopped=false,timer,failures=0;
  const launch=()=>{
    if(stopped) return;
    const started=Date.now(); let finished=false;
    child=spawn(command,args,options);
    const finishedChild=(code,error)=>{
      if(finished) return; finished=true;
      if(stopped) return;
      if(Date.now()-started>=stableMs) failures=0;
      const delay=Math.min(maxDelay,minDelay*2**Math.min(failures++,6));
      onState({state:'restarting',code,error:error?.message,delay});
      timer=setTimeout(launch,delay);
    };
    child.once('spawn',()=>onState({state:'starting',pid:child.pid}));
    child.once('error',error=>finishedChild(null,error));
    child.once('exit',code=>finishedChild(code));
  };
  launch();
  return {get child(){return child;},stop(){stopped=true;clearTimeout(timer);child?.stdin?.end();child?.kill();}};
}
