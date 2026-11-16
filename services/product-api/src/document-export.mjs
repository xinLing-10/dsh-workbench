import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {buildDocx} from '../../../packages/manager-core/index.mjs';
import {writePdf,writePptx} from '../../../dsh-workbench/core/delivery-export.js';
export const exportTypes={docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',pdf:'application/pdf',pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation'};
export async function exportDocument(bytes,name,format){
 if(!Object.hasOwn(exportTypes,format))throw Object.assign(Error('不支持的导出格式'),{status:400});
 if(!/\.(md|markdown|txt)$/i.test(name)||bytes.length>200000)throw Object.assign(Error('格式转换仅支持不超过200KB的文字成果'),{status:400});
 const title=name.replace(/\.[^.]+$/,''),markdown=bytes.toString('utf8');
 if(format==='docx')return buildDocx(markdown,title);
 const dir=await mkdtemp(join(tmpdir(),'manager-export-'));
 try{const file=join(dir,'document.'+format);await (format==='pdf'?writePdf:writePptx)(file,{markdown,title});return await readFile(file);}finally{await rm(dir,{recursive:true,force:true});}
}
