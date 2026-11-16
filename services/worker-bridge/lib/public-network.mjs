/** Credential-free outbound broker. Tool containers keep --network=none. */
import https from 'node:https';
import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import {createHash,randomUUID} from 'node:crypto';
import {realpath,lstat} from 'node:fs/promises';
import {mkdirSync,openSync,closeSync,writeFileSync,rmSync,lstatSync,realpathSync,readdirSync,statSync,constants} from 'node:fs';
import {join} from 'node:path';
const sha = b => createHash('sha256').update(b).digest('hex');
export function publicAddress(ip) {
 if(isIP(ip)===4){const [a,b,c]=ip.split('.').map(Number);return !(ip==='168.63.129.16'||a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&(b===168||b===0||b===88&&c===99)||a===198&&(b===18||b===19||b===51&&c===100)||a===203&&b===0&&c===113||a===100&&b>=64&&b<=127);}
 if(isIP(ip)===6){const v=new URL('https://['+ip+']/').hostname.slice(1,-1);return /^[23][0-9a-f]{3}:/.test(v)&&!/^2001:(?:0*:|db8:|0*2:|0*1[0-9a-f]:)/.test(v)&&!/^2002:/.test(v);}
 return false;
}
export function publicUrl(value) {
 if(typeof value!=='string'||value.length>2048)throw Error('网络地址无效');
 const u=new URL(value);const host=u.hostname.replace(/^\[|\]$/g,'');
 if(u.protocol!=='https:'||u.port&&u.port!=='443'||u.username||u.password||host==='localhost'||/\.(?:local|internal|localhost)$/.test(host)||[...u.searchParams.keys()].some(k=>/^(?:password|token|api[_-]?key|access[_-]?token|secret|signature)$/i.test(k))||isIP(host)&&!publicAddress(host))throw Error('仅允许不含凭据的公网 HTTPS 地址');
 u.hash='';return u;
}
export async function publicGet(value,{signal,maxBytes=524288,allowedHosts,resolve=lookup,request=https.request}={}) {
 const timeout=AbortSignal.timeout(15000),abort=signal?AbortSignal.any([signal,timeout]):timeout;
 let url=publicUrl(value);
 for(let redirect=0;redirect<=3;redirect++){
  abort.throwIfAborted();const host=url.hostname.replace(/^\[|\]$/g,'');
  if(allowedHosts&&!allowedHosts.includes(host))throw Error('目标不在允许的依赖文件源中');
  const records=await new Promise((yes,no)=>{
   const cancel=()=>no(abort.reason);abort.addEventListener('abort',cancel,{once:true});
   Promise.resolve(isIP(host)?[{address:host,family:isIP(host)}]:resolve(host,{all:true,verbatim:true})).then(yes,no).finally(()=>abort.removeEventListener('abort',cancel));
  });
  abort.throwIfAborted();if(!records.length||records.some(r=>!publicAddress(r.address)))throw Error('目标解析到内网、保留地址或云元数据，拒绝访问');
  const chosen=records[0];
  const result=await new Promise((yes,no)=>{
   const req=request(url,{method:'GET',agent:false,autoSelectFamily:false,headers:{'user-agent':'ManagerPublicReader/1.0','accept-encoding':'identity'},signal:abort,lookup:(_host,_options,cb)=>cb(null,chosen.address,chosen.family)},res=>{
    if([301,302,303,307,308].includes(res.statusCode)){res.resume();yes({redirect:res.headers.location});return;}
    if(res.statusCode<200||res.statusCode>=300){res.resume();no(Error('网页返回 HTTP '+res.statusCode));return;}
    if(res.headers['content-encoding']&&res.headers['content-encoding']!=='identity'){res.resume();no(Error('不支持压缩响应'));return;}
    const chunks=[];let size=0;
    res.on('data',chunk=>{size+=chunk.length;if(size>maxBytes){res.destroy();no(Error('下载内容超过大小限制'));}else chunks.push(chunk);});
    res.on('error',no);res.on('aborted',()=>no(Error('下载连接中断')));res.on('end',()=>yes({bytes:Buffer.concat(chunks),type:String(res.headers['content-type']||'').split(';')[0],url:url.href}));
   });req.on('error',no);req.end();
  });
  if(result.redirect!==undefined){if(!result.redirect||redirect===3)throw Error('网页跳转过多或目标缺失');url=publicUrl(new URL(result.redirect,url).href);continue;}
  return result;
 }
 throw Error('网页跳转失败');
}
const entities=s=>s.replace(/&(?:amp|lt|gt|quot|apos);/g,v=>({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'"}[v]));
export function readablePage(bytes,type,url) {
 if(!/^(?:text\/(?:html|plain|markdown|xml)|application\/(?:json|xml|rss\+xml|xhtml\+xml))$/.test(type))throw Error('只支持公开文字网页、文档或JSON');
 const raw=new TextDecoder('utf-8',{fatal:true}).decode(bytes);if(raw.includes('\0'))throw Error('不支持二进制网页');
 const title=entities(raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/<[^>]*>/g,'').trim()||new URL(url).hostname).slice(0,200);
 const text=entities(type.includes('html')?raw.replace(/<(script|style|nav|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi,' ').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim():raw);
 return {title,text:text.slice(0,16000),truncated:text.length>16000};
}
export const DEPENDENCY_HOSTS=['registry.npmjs.org','files.pythonhosted.org'];
export function createPublicNetwork({enabled=false,workspaceRoot,get=publicGet}={}) {
 const ready=()=>{if(!enabled)throw Error('受控联网未启用，请联系管理员配置；未访问网络');};
 return {enabled,
  async read(url,{signal}={}){ready();const page=await get(url,{signal}),content=readablePage(page.bytes,page.type,page.url);return {...content,url:page.url,sha256:sha(page.bytes),fetchedAt:new Date().toISOString()};},
  async search(query,{signal}={}){ready();if(typeof query!=='string'||!query.trim()||query.length>300)throw Error('搜索词需为1—300字');const page=await get('https://www.bing.com/search?format=rss&q='+encodeURIComponent(query),{signal});const xml=page.bytes.toString('utf8');const results=[...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0,6).flatMap(m=>{try{const url=entities(m[1].match(/<link>([\s\S]*?)<\/link>/)?.[1]||'');publicUrl(url);return [{title:entities(m[1].match(/<title>([\s\S]*?)<\/title>/)?.[1]||'').slice(0,200),url}];}catch{return [];}});return {results,note:'搜索结果尚未读取，不能作为已核实引用；请调用read_public_web读取选中页面。'};},
  async download({projectId,url,sha256,integrity,signal}) {
   ready();const u=publicUrl(url);if(!DEPENDENCY_HOSTS.includes(u.hostname)||u.search||!/\.(?:tgz|whl|tar\.gz|zip)$/.test(u.pathname)||(!/^[a-f0-9]{64}$/.test(sha256||'')&&!/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity||'')))throw Error('仅支持npm/Python官方文件源的固定包地址，必须提供从可信元数据获得的SHA-256或npm SHA-512完整性摘要');
   if(!/^[A-Za-z0-9_]+$/.test(projectId))throw Error('项目标识无效');
   const base=await realpath(workspaceRoot),root=join(base,projectId);if((await lstat(root)).isSymbolicLink()||await realpath(root)!==root)throw Error('项目路径异常');
   const page=await get(url,{signal,maxBytes:16777216,allowedHosts:DEPENDENCY_HOSTS});if(!DEPENDENCY_HOSTS.includes(publicUrl(page.url).hostname))throw Error('依赖跳转到了未允许的文件源');
   const actual=sha(page.bytes);if(sha256&&actual!==sha256||integrity&&'sha512-'+createHash('sha512').update(page.bytes).digest('base64')!==integrity)throw Error('依赖校验摘要不一致，未保存文件');
   // No yield between the final directory validation and open. Linux dir-fd anchoring
   // prevents a concurrent container from redirecting a parent symlink during the write.
   const dir=join(root,'manager-downloads');mkdirSync(dir,{recursive:true,mode:0o700});if(lstatSync(dir).isSymbolicLink()||realpathSync(dir)!==dir)throw Error('下载目录异常');
   const fd=openSync(dir,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
   const filename=randomUUID()+'-'+actual+u.pathname.match(/\.(?:tgz|whl|tar\.gz|zip)$/)[0],path='manager-downloads/'+filename;
   const anchored=process.platform==='linux'?'/proc/self/fd/'+fd:dir,absolute=join(anchored,filename);
   try{
    let total=0;const existing=readdirSync(anchored);if(existing.length>=64)throw Error('下载文件数量已达64个，请管理员清理后继续');
    for(const name of existing){const p=join(anchored,name);if(lstatSync(p).isSymbolicLink())throw Error('下载目录含异常链接');total+=statSync(p).size;}
    if(total+page.bytes.length>67108864)throw Error('当前项目依赖下载累计超过64MiB，请管理员清理后继续');
    signal?.throwIfAborted();writeFileSync(absolute,page.bytes,{flag:'wx',mode:0o600});
   }catch(e){rmSync(absolute,{force:true});throw e;}finally{closeSync(fd);}
   return {path,bytes:page.bytes.length,sha256:actual,url:page.url,note:'仅下载并校验，未解压、安装或运行；递归依赖未自动下载。安装需另行授权。'};
  }
 };
}
export function citeSources(text,sources) {
 if(!sources.length)return text;
 const footer='\n\n**内容来源（实际读取）**\n'+sources.map((s,i)=>`- [${i+1}] [${s.title.replace(/[\[\]<>\n\r]/g,' ')}](${s.url}) · ${s.fetchedAt} · SHA-256 ${s.sha256}`).join('\n');
 try{const data=JSON.parse(text.trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,''));
  if(Array.isArray(data.documents)){for(const d of data.documents)if(typeof d.markdown==='string')d.markdown+=footer;data.summary=String(data.summary||'')+footer;return JSON.stringify(data);}
  if(data.version===2||typeof data.reply==='string')return text; // citations travel in the trusted receipt, never break manager JSON
 }catch{}
 return text;
}
