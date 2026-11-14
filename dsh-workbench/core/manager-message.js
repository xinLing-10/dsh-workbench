import MarkdownIt from 'markdown-it';
import { createHash } from 'node:crypto';
const markdown = new MarkdownIt({ html: false, linkify: false, breaks: false });
const text = (v, max = 2000) => typeof v === 'string' ? v.trim().slice(0, max) : '';
export function protocolError() { const e = new Error('管家回复格式异常，本次未创建执行安排。请重新发送消息；原文可在处理记录中核对。'); e.code = 'INVALID_MANAGER_REPLY'; return e; }
const unsafe = v => /<\/?[|｜][^>]*>|<\/?(?:tool_call|function_call|DSML)\b/i.test(v);
export function safeLink(href) { return /^https?:\/\//i.test(href) && !/[\x00-\x20]/.test(href) ? href : ''; }
function inline(tokens = []) {
  return tokens.map(t => {
    if (t.type === 'link_open') return { type: t.type, href: safeLink(t.attrGet('href') || '') };
    return { type: t.type, text: t.content || '', tag: t.tag };
  }).filter(t => ['text','code_inline','softbreak','hardbreak','strong_open','strong_close','em_open','em_close','s_open','s_close','link_open','link_close'].includes(t.type));
}
/** Markdown AST only; HTML stays escaped text and no raw HTML crosses to the UI. */
export function markdownNodes(source) {
  return markdown.parse(text(source, 10000), {}).map(t => ({ type: t.type, tag: t.tag, text: t.type === 'fence' || t.type === 'code_block' ? t.content : '', children: inline(t.children || []), start: t.attrGet('start') || '' }));
}
export function parseReply(source) {
  const raw = text(source, 20000).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  if (!raw || unsafe(raw)) throw protocolError();
  let data;
  try { data = JSON.parse(raw); }
  catch {
    if (/^(?:\{\s*"|\[\s*\{)/.test(raw) || /"(?:reply|proposal|blocks)"\s*:/.test(raw)) throw protocolError();
    return { reply: raw.slice(0,8000), proposal: null };
  }
  if (!data || Array.isArray(data) || typeof data !== 'object') throw protocolError();
  const p = data.proposal;
  const proposal = p && ['spec','design','build','verify','ship'].includes(p.stage) && text(p.instruction,6000) ? { stage:p.stage, instruction:text(p.instruction,6000) } : null;
  if (data.version === 2) {
    if (!Array.isArray(data.blocks) || data.blocks.length === 0 || data.blocks.length > 12) throw protocolError();
    let questions=0;
    const blocks=data.blocks.map(b => {
      if (!b || !['summary','paragraph','list','question','details','document'].includes(b.type)) throw protocolError();
      if(b.type==='list') {
        if(!Array.isArray(b.items) || b.items.length===0 || b.items.length>8 || b.items.some(v=>!text(v,500)))throw protocolError();
        return {type:b.type,title:text(b.title,80),items:b.items.map(v=>text(v,500))};
      }
      if(b.type==='document') { if(!text(b.name,200))throw protocolError();return {type:'document',name:text(b.name,200)}; }
      const value=text(b.text,b.type==='summary'?240:3000);if(!value)throw protocolError();
      if(b.type==='question') {
        if(++questions>2)throw protocolError();
        const options=Array.isArray(b.options)?b.options.map(v=>text(v,120)):[];
        if(options.length>4 || options.some(v=>!v) || new Set(options).size!==options.length)throw protocolError();
        return {type:'question',text:value,options};
      }
      return {type:b.type,title:text(b.title,80),text:value};
    });
    return { reply:blocks.map(b=>b.text || (b.items || []).join('\n') || b.name).join('\n\n'), blocks, proposal };
  }
  if (!text(data.reply,8000)) throw protocolError();
  return {reply:text(data.reply,8000),proposal};
}
export function questionId(stage, question) { return createHash('sha256').update(stage+'\0'+question).digest('hex').slice(0,24); }
export function prepareBlocks(blocks, stage, answers={}, outputs=[]) {
  return blocks.flatMap(b=>{
    if(b.type==='question') { const id=questionId(stage,b.text); return answers[id]?[]:[{...b,id,stage}]; }
    if(b.type==='document') { const doc=outputs.find(o=>o.name===b.name);return doc?[{type:'document',name:doc.name,stage:doc.stage}]:[]; }
    return [b];
  });
}
export function presentMessage(message, answers={}) {
  if(message.role==='user')return message;
  // Old malformed JSON is never displayed as a normal assistant reply.
  if(unsafe(message.text || '') || (/^\s*[\[{]/.test(message.text || '') && /"(?:reply|proposal|blocks)"\s*:/.test(message.text || '')))return {...message,text:'这条历史回复格式异常，请查看处理记录或重新提问。',blocks:[{type:'paragraph',text:'这条历史回复格式异常，请查看处理记录或重新提问。'}]};
  const blocks=(message.blocks || [{type:'paragraph',text:message.text}]).map(b=>({...b,
    ...(b.type==='question'?{answer:answers[b.id]?.text || ''}:{}),
    ...(b.text?{nodes:markdownNodes(b.text)}:{}),
    ...(b.items?{itemNodes:b.items.map(markdownNodes)}:{})}));
  return {...message,blocks};
}
