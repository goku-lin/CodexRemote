import {renderChatgptMarkdown} from '../public/chatgpt-markdown.js';

const escape=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[char]));

// No scripts, raw HTML, automatic images or local subresource reads. A document
// grants access only to its own text; linked files need their own authorization.
export function renderDocument(text,name,{plain=false}={}){
  const content=plain ? '<pre>'+escape(text)+'</pre>' : renderChatgptMarkdown(text).replace(/<a href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g,(original,href,label)=>/^(?:https?:\/\/|mailto:)/i.test(href) ? original : label);
  return '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+escape(name)+'</title><style>'+ 
    'html{color-scheme:dark light}body{margin:0;background:#191b1f;color:#e4e8ee;font:16px/1.85 system-ui,"Microsoft YaHei",sans-serif;overflow-wrap:anywhere}main{max-width:860px;margin:auto;padding:20px clamp(16px,4vw,36px) 64px}header{font-size:12px;color:#99a6b8;border-bottom:1px solid #373e49;padding-bottom:14px;margin-bottom:28px}h1,h2,h3,h4{line-height:1.4;color:#f1f4f8}h1{font-size:1.7em}h2{font-size:1.35em;margin-top:1.8em}a{color:#8ebeff}blockquote{margin:16px 0;padding:4px 16px;border-left:3px solid #63859e;color:#b6c2d1;background:#21262d}pre{white-space:pre-wrap;padding:14px;background:#101318;border-radius:8px}code{font-family:Consolas,monospace;background:#262d36;padding:2px 4px;border-radius:3px}pre code{background:none;padding:0}.markdown-table{max-width:100%;overflow:auto}table{border-collapse:collapse;font-size:.93em;min-width:100%}td,th{border:1px solid #3d4654;padding:8px 12px;vertical-align:top}th{background:#252c35}li{margin:5px 0}@media(prefers-color-scheme:light){body{background:#fafafa;color:#26303b}h1,h2,h3,h4{color:#172332}header{color:#596b7c;border-color:#ccd4dd}a{color:#185ca4}blockquote,th{background:#eef2f6;color:#44546a}code{background:#e8edf2}pre{background:#eef2f6}td,th{border-color:#cad2dc}}'+
    '</style><main><header>本机文档 · '+escape(name)+'</header><article>'+content+'</article></main></html>';
}
