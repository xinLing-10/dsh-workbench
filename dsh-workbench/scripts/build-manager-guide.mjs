/** Reproducible, self-contained reader generated from the canonical user guide. */
import MarkdownIt from 'markdown-it';
import {readFile,writeFile,realpath} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {dirname,resolve,sep,extname} from 'node:path';
const docs=resolve(dirname(fileURLToPath(import.meta.url)),'../docs');
const admin=process.argv.includes('--admin');
const guideName=admin?'manager-admin-guide':'manager-user-guide';
const guideTitle=admin?'项目管家管理员使用手册':'项目管家使用手册';
const headerTitle=admin?'项目管家 · 管理员使用手册':'项目管家 · 新手使用手册';
const subtitle=admin?'服务概览、邀请、额度与任务核对。图文指引，离线可读。':'说想法，答问题，看成果。需要时再展开高级操作。';
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const parser=new MarkdownIt({html:false,linkify:false});
const source=await readFile(resolve(docs,guideName+'.md'),'utf8');
const tokens=parser.parse(source,{});const nav=[];let index=0,images=0;
for(let i=0;i<tokens.length;i++) {
 const token=tokens[i];
 if(token.type==='heading_open' && token.tag==='h2') {const id=`section-${++index}`;token.attrSet('id',id);nav.push({id,title:tokens[i+1].content});}
 for(const child of token.children || []) {
  if(child.type!=='image')continue;
  const asset=await realpath(resolve(docs,child.attrGet('src')));
  if(!asset.startsWith(docs+sep))throw new Error('Guide images must remain inside docs');
  const mime={'.png':'image/png','.svg':'image/svg+xml'}[extname(asset)];if(!mime)throw new Error('Unsupported guide image');
  child.attrSet('src',`data:${mime};base64,${(await readFile(asset)).toString('base64')}`);images++;
 }
}
const body=parser.renderer.render(tokens,parser.options,{});
const html=`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(guideTitle)}</title><style>
:root{color-scheme:light}*{box-sizing:border-box}body{margin:0;background:#f4f6fa;color:#223047;font:16px/1.85 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;line-height:1.85}header{background:#172e52;color:white;padding:36px max(24px,calc((100% - 1160px)/2))}header strong{display:block;font-size:28px}header p{margin:8px 0;opacity:.85}button{font:inherit;padding:6px 16px;border:0;border-radius:8px;background:#fff;color:#172e52;cursor:pointer}.layout{max-width:1200px;margin:32px auto;display:grid;grid-template-columns:230px minmax(0,1fr);gap:30px;padding:0 22px}nav{position:sticky;top:20px;align-self:start;font-size:14px}nav a{display:block;padding:8px 10px;text-decoration:none;color:#334e74}nav a:hover{background:#e6edfa;border-radius:8px}main{background:white;padding:32px 42px;border-radius:16px;min-width:0}h1{font-size:30px;line-height:1.4}h2{font-size:23px;margin:44px 0 18px;color:#173c6a;scroll-margin-top:25px}h3{font-size:19px}strong{color:inherit}p{margin:14px 0}img{display:block;max-width:100%;height:auto;border:1px solid #e4e9f0;border-radius:10px;margin:24px auto 8px}p:has(>em){font-size:14px;color:#65748a}blockquote{margin:18px 0;background:#f0f5ff;border-left:4px solid #537ed2;padding:8px 18px;border-radius:0 8px 8px 0}li{margin:7px 0}table{border-collapse:collapse;width:100%;font-size:14px;margin:22px 0}th,td{border:1px solid #dae1eb;padding:10px 12px;text-align:left;vertical-align:top}th{background:#f0f4fa}code{background:#edf1f6;padding:2px 5px;border-radius:4px;overflow-wrap:anywhere}a{color:#285ca9}footer{color:#6a788d;text-align:center;padding:24px;font-size:13px}@media(max-width:850px){.layout{display:block;margin-top:18px;padding:0 12px}nav{position:static;margin:0 0 20px}nav a{display:inline-block}main{padding:20px}table{display:block;overflow-x:auto}}@media print{body{background:white;font-size:11pt}header{background:white;color:black;padding:0}header button,nav,footer{display:none}.layout{display:block;padding:0;margin:0}main{padding:0}h2{break-after:avoid}img{max-height:210mm;object-fit:contain;break-inside:avoid}tr,blockquote{break-inside:avoid}a{color:inherit}@page{size:A4;margin:18mm}}
</style></head><body><header><strong>${escape(headerTitle)}</strong><p>${escape(subtitle)}</p><button type="button" onclick="window.print()">打印 / 保存为 PDF</button></header><div class="layout"><nav aria-label="手册目录">${nav.map(n=>`<a href="#${n.id}">${escape(n.title)}</a>`).join('')}</nav><main>${body}</main></div><footer>本文件由 ${escape(guideName)}.md 生成，截图已内嵌，离线可读。</footer></body></html>`;
await writeFile(resolve(docs,guideName+'.html'),html);
console.log(`Built offline guide: ${images} embedded images, ${nav.length} sections.`);
