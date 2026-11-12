import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReply, markdownNodes, safeLink, prepareBlocks, presentMessage } from '../manager-message.js';
test('validated blocks, bounded questions and unsafe protocol markers',()=>{
  const reply=parseReply(JSON.stringify({version:2,blocks:[{type:'summary',text:'完成了结构检查'},{type:'question',text:'你想选择哪种方案？',options:['A','B']}],proposal:{stage:'spec',instruction:'整理需求'}}));
  assert.equal(reply.blocks.length,2);assert.equal(reply.proposal.stage,'spec');
  for(const source of ['{"reply":','<｜DSML｜tool_call>','{"version":2,"blocks":[{"type":"unknown","text":"bad"}]}',JSON.stringify({version:2,blocks:Array.from({length:3},()=>({type:'question',text:'选择？'}))})])assert.throws(()=>parseReply(source),{code:'INVALID_MANAGER_REPLY'});
  assert.equal(parseReply('[帮助](https://example.org)').reply,'[帮助](https://example.org)');
});
test('Markdown AST preserves headings, tables, code and paragraphs without executable HTML',()=>{
  const nodes=markdownNodes('## 结果\n\n**重点**与[来源](https://example.org)\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```js\nalert(1)\n```\n\n<script>alert(1)</script>');
  assert.ok(nodes.some(n=>n.type==='heading_open'));assert.ok(nodes.some(n=>n.type==='table_open'));assert.ok(nodes.some(n=>n.type==='fence'));
  assert.ok(!nodes.some(n=>n.type==='html_block'));assert.equal(safeLink('javascript:alert(1)'),'');assert.equal(safeLink('file:///etc/passwd'),'');
});
test('answers deduplicate questions by stage and document references stay board-bound',()=>{
  const blocks=[{type:'question',text:'请选择？',options:[]},{type:'document',name:'不存在.md'}];
  const first=prepareBlocks(blocks,'spec');assert.equal(first.length,1);
  assert.deepEqual(prepareBlocks(blocks,'spec',{[first[0].id]:{text:'选择A'}}),[]);
  assert.equal(prepareBlocks(blocks,'design').length,1);
  assert.equal(presentMessage({role:'assistant',text:'{"reply":"bad"}'}).blocks[0].text.includes('格式异常'),true);
});
