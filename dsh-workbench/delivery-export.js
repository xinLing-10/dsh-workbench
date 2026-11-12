import PDFDocument from 'pdfkit';
import { createRequire } from 'node:module';
const PptxGenJS=createRequire(import.meta.url)('pptxgenjs');
import MarkdownIt from 'markdown-it';
import { existsSync, createWriteStream } from 'node:fs';
import { finished } from 'node:stream/promises';
const parser=new MarkdownIt({html:false,linkify:false});
export function pdfFont() {
  return [process.env.DSH_PDF_FONT,'/System/Library/Fonts/Supplemental/Arial Unicode.ttf','/usr/share/fonts/truetype/arphic/uming.ttc','/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc'].filter(Boolean).find(existsSync) || '';
}
export function exportBlocks(markdown) {
  const blocks=[];let heading='',table=null,row=null,prefix='';const lists=[];
  for(const t of parser.parse(markdown,{})) {
    if(t.type==='bullet_list_open')lists.push({kind:'bullet'});
    if(t.type==='ordered_list_open')lists.push({kind:'number',next:Number(t.attrGet('start') || 1)});
    if(t.type==='bullet_list_close' || t.type==='ordered_list_close')lists.pop();
    if(t.type==='list_item_open'){const list=lists.at(-1);prefix=list?.kind==='number'?`${list.next++}. `:'• ';}
    if(t.type==='table_open'){table=[];continue;}
    if(t.type==='tr_open'){row=[];continue;}
    if(t.type==='tr_close' && table){table.push(row);continue;}
    if(t.type==='table_close'){blocks.push({kind:'table',rows:table});table=null;continue;}
    if(t.type==='heading_open')heading=t.tag;
    if(t.type==='inline') {const text=t.children?.map(c=>c.type==='softbreak'?'\n':c.content || '').join('') || t.content;if(table)row.push(text);else {blocks.push({kind:heading || 'paragraph',text:prefix+text});prefix='';}}
    if(t.type==='heading_close')heading='';
    if(t.type==='fence')blocks.push({kind:'code',text:t.content});
  }
  return blocks;
}
/** Local semantic PDF: independent of an office application; custom Word layout is not reproduced. */
export async function writePdf(path,{markdown,title,font=pdfFont()}) {
  if(!font)throw new Error('未找到中文字体。请配置 DSH_PDF_FONT 后重试 PDF 导出。');
  const doc=new PDFDocument({size:'A4',margins:{top:58,bottom:58,left:56,right:56},info:{Title:title},bufferPages:true});
  const stream=createWriteStream(path);const completion=finished(stream);
  doc.pipe(stream);
  try {
    doc.font(font,process.env.DSH_PDF_FONT_FAMILY || (/\.ttc$/i.test(font)?(/uming/i.test(font)?'UMingCN':'NotoSansCJKsc-Regular'):undefined));
    for(const block of exportBlocks(markdown)) {
      if(block.kind==='table') {
        // Keep long cells readable; each row is a labelled record across pages.
        const [headers,...rows]=block.rows;
        for(const row of rows) {doc.fontSize(10).fillColor('#202a38');row.forEach((cell,i)=>doc.text(`${headers[i] || i+1}：${cell}`,{lineGap:4,paragraphGap:5}));doc.moveDown(.6);}
        continue;
      }
      const size=block.kind==='h1'?21:block.kind==='h2'?16:block.kind.startsWith('h')?13:11;
      doc.fontSize(size).fillColor(block.kind.startsWith('h')?'#163254':'#202a38');
      if(doc.y>doc.page.height-110)doc.addPage();
      doc.text(block.text,{lineGap:5,paragraphGap:8});doc.moveDown(.45);
    }
    const range=doc.bufferedPageRange();
    for(let i=range.start;i<range.start+range.count;i++) {doc.switchToPage(i);doc.fontSize(9).fillColor('#687385').text(`${i+1} / ${range.count}`,56,doc.page.height-40,{lineBreak:false});}
    doc.end();await completion;
  } catch(error) {doc.destroy();stream.destroy();await completion.catch(()=>{});throw error;}
}
function wrap(text,max=43) {
  const lines=[];let line='',width=0;
  for(const char of text) {
    const w=/[\x00-\xff]/.test(char)?.55:1;
    if(char==='\n' || width+w>max) {lines.push(line);line='';width=0;if(char==='\n')continue;}
    line+=char;width+=w;
  }
  if(line)lines.push(line);return lines;
}
/** Editable native text boxes, shapes, and table cells; no screenshots. */
export async function writePptx(path,{markdown,title}) {
  const pptx=new PptxGenJS();pptx.layout='LAYOUT_WIDE';pptx.author='DSH Workbench';pptx.subject=title;pptx.title=title;pptx.lang='zh-CN';
  pptx.theme={headFontFace:'Microsoft YaHei',bodyFontFace:'Microsoft YaHei',lang:'zh-CN'};
  let currentTitle=title,lines=[],slideCount=0;
  const slide=()=>{
    const s=pptx.addSlide();slideCount++;s.background={color:'F8FAFD'};
    s.addShape(pptx.ShapeType.rect,{x:0,y:0,w:0.16,h:7.5,fill:{color:'3568C0'},line:{color:'3568C0'}});
    const titleLines=wrap(currentTitle,36);
    s.addText(titleLines.slice(0,2).join('\n'),{x:.65,y:.35,w:12,h:1.05,fontSize:26,bold:true,color:'173558',margin:0,breakLine:false});
    if(title.startsWith('草稿'))s.addText('草稿 · 待补充与确认',{x:.75,y:7,w:7,h:.2,fontSize:10,color:'A65A15',margin:0});
    s.addText(String(slideCount),{x:12,y:7,w:.5,h:.2,fontSize:10,color:'73849A',margin:0});return s;
  };
  const flush=()=>{if(!lines.length)return;const s=slide();s.addText(lines.join('\n'),{x:.75,y:1.65,w:11.85,h:5.05,fontSize:20,margin:0,valign:'top',color:'25374A',lineSpacingMultiple:1.2,paraSpaceAfterPt:8});lines=[];};
  for(const block of exportBlocks(markdown)) {
    if(block.kind==='table') {
      flush();const [headers,...rows]=block.rows;
      // Split wide tables into groups; preserve the first column as context.
      for(let offset=1;offset<headers.length || offset===1;offset+=4) {
        const cols=[0,...headers.slice(offset,offset+4).map((_,i)=>i+offset)];
        const s=slide();s.addTable([headers,...rows].map(row=>cols.map(i=>({text:row[i] || '',options:{}}))),{x:.75,y:1.65,w:11.85,h:4.9,fontSize:16,color:'25374A',border:{color:'CBD5E1',pt:1},margin:.1,autoPage:true,autoPageRepeatHeader:true,autoPageSlideStartY:1.65,colW:cols.map(()=>11.85/cols.length)});
      }
      continue;
    }
    if(block.kind==='h1'){flush();currentTitle='项目交付演示';for(const line of wrap(block.text,38)){if(lines.length>=9)flush();lines.push(line);}flush();currentTitle=block.text;continue;}
    if(/^h[12]$/.test(block.kind)){flush();currentTitle=block.text;const extra=wrap(currentTitle,36).slice(2);if(extra.length)for(const line of extra){if(lines.length>=9)flush();lines.push(line);};continue;}

    for(const line of wrap(block.text)) {if(lines.length>=9)flush();lines.push(line);}
    if(lines.length<9)lines.push('');
  }
  flush();if(!slideCount)slide();
  await pptx.writeFile({fileName:path,compression:true});return {slides:slideCount};
}
