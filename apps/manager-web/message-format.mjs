/** Small text-only Markdown subset. Raw HTML, links and images remain literal text. */
export function inlineParts(text){return String(text).split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/g).filter(Boolean).map(value=>value.startsWith('**')&&value.endsWith('**')?{tag:'strong',text:value.slice(2,-2)}:value.startsWith('`')&&value.endsWith('`')?{tag:'code',text:value.slice(1,-1)}:{tag:'text',text:value});}
export function messageBlocks(text){
 const lines=String(text).replace(/\r\n/g,'\n').split('\n'),blocks=[];let i=0;
 const special=line=>/^(#{1,6}\s|[-*+]\s|\d+[.)]\s|```|>\s)/.test(line);
 while(i<lines.length){const line=lines[i];if(!line.trim()){i++;continue;}
  if(line.startsWith('```')){const code=[];i++;while(i<lines.length&&!lines[i].startsWith('```'))code.push(lines[i++]);if(i<lines.length)i++;blocks.push({tag:'pre',text:code.join('\n')});continue;}
  const heading=line.match(/^(#{1,6})\s+(.+)$/);if(heading){blocks.push({tag:'h'+Math.min(4,heading[1].length+1),text:heading[2]});i++;continue;}
  const list=line.match(/^([-*+]|\d+[.)])\s+(.+)$/);if(list){const ordered=/^\d/.test(list[1]),items=[];while(i<lines.length){const item=lines[i].match(/^([-*+]|\d+[.)])\s+(.+)$/);if(!item||/^\d/.test(item[1])!==ordered)break;items.push(item[2]);i++;}blocks.push({tag:ordered?'ol':'ul',items});continue;}
  const quote=line.match(/^>\s?(.*)$/);if(quote){blocks.push({tag:'blockquote',text:quote[1]});i++;continue;}
  const paragraph=[line];i++;while(i<lines.length&&lines[i].trim()&&!special(lines[i]))paragraph.push(lines[i++]);blocks.push({tag:'p',text:paragraph.join('\n')});
 }return blocks;
}
export function renderMessage(document,text){const fragment=document.createDocumentFragment();const inline=(node,value)=>{for(const part of inlineParts(value)){if(part.tag==='text')node.append(document.createTextNode(part.text));else{const child=document.createElement(part.tag);child.textContent=part.text;node.append(child);}}};for(const block of messageBlocks(text)){const node=document.createElement(block.tag);if(block.items)for(const value of block.items){const li=document.createElement('li');inline(li,value);node.append(li);}else if(block.tag==='pre')node.textContent=block.text;else inline(node,block.text);fragment.append(node);}return fragment;}
