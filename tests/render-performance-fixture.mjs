// Run with: node tests/render-performance-fixture.mjs
// Optional baseline files can be captured in .relay-data/verification before
// editing app.js and dom-sync.js, then compared via /fixture?baseline=1.
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url)),proof=path.join(root,'.relay-data/verification');
const server=createServer(async(req,res)=>{
  try {
    const url=new URL(req.url,'http://localhost');
    let content,type='text/html';
    if(url.pathname==='/app-profile.js') {
      const baseline=url.searchParams.get('baseline')==='1';
      content=(await readFile(baseline ? path.join(proof,'render-baseline-app.js') : path.join(root,'public/app.js'),'utf8')).split("$('newTaskBtn').onclick")[0];
      if(baseline)content=content.replace("'./dom-sync.js'","'./baseline-dom-sync.js'");
      content+='\nexport {state,renderTurn,renderTimeline,renderMarkdown,timelineViewport};';type='text/javascript';
    } else {
      const relative=url.pathname==='/fixture' ? 'tests/render-performance.browser.html' : url.pathname==='/baseline-dom-sync.js' ? '.relay-data/verification/render-baseline-dom-sync.js' : url.pathname.startsWith('/tests/') ? '.'+url.pathname : 'public'+url.pathname;
      const file=path.resolve(root,relative);
      if(!file.startsWith(root))throw new Error('Invalid path');
      content=await readFile(file,'utf8');
      type=file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html';
    }
    res.writeHead(200,{'content-type':type,'cache-control':'no-store'});res.end(content);
  } catch(error) {res.writeHead(404);res.end(error.message);}
});
server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({url:`http://127.0.0.1:${server.address().port}/fixture`})));
