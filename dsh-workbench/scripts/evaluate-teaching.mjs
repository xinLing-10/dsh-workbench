#!/usr/bin/env node
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {teachingReport,evaluationPrompt} from '../teaching-eval.js';
const args=process.argv.slice(2),options={};
for(let i=0;i<args.length;i+=2){if(!['--fixtures','--responses','--output','--export-prompts'].includes(args[i]) || !args[i+1])throw new Error('用法：npm run eval:teaching -- [--export-prompts 文件] [--responses 回复JSON --output 报告JSON]');options[args[i]]=args[i+1];}
const fixtures=JSON.parse(await readFile(options['--fixtures']?resolve(options['--fixtures']):fileURLToPath(new URL('../docs/teaching-eval-cases.json',import.meta.url)),'utf8'));
if(!Array.isArray(fixtures.cases))throw new Error('评测案例格式无效。');
async function output(path,value){const file=resolve(path);await mkdir(dirname(file),{recursive:true});await writeFile(file,JSON.stringify(value,null,2)+'\n',{flag:'wx'});}
if(options['--export-prompts'])await output(options['--export-prompts'],{notice:'仅含虚构项目与教学案例。请用目标模型回答后保存为 {案例ID:原始回复字符串}。本工具不读取凭据、不调用模型。',cases:fixtures.cases.map(example=>({...example,modelPrompt:evaluationPrompt(example)}))});
if(options['--responses']){
 const responses=JSON.parse(await readFile(resolve(options['--responses']),'utf8'));
 const report=teachingReport(fixtures.cases,responses);
 if(options['--output'])await output(options['--output'],report);
 console.log(JSON.stringify({cases:fixtures.cases.length,...report.summary,modelCalls:0,learningOutcomeValidated:false}));
 if(report.results.some(r=>r.status==='invalid-response' || r.status==='missing-response' || r.status==='needs-attention'))process.exitCode=2;
}else console.log(`已准备 ${fixtures.cases.length} 个教学案例（虚构产品与公开维护代码片段）。没有调用模型或认定教学通过；用 --export-prompts 导出输入，--responses 检查已有模型回复。`);
