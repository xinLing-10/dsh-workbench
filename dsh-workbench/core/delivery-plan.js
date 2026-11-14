import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { STAGES, DOCUMENTS, boardDirectory, managedPath, listApprovalHistory, artifactReview } from './artifacts.js';
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
/** Resolve exact approval receipts and verify both snapshots and current approval validity. */
export async function approvedSources(root,id,state,names) {
  const receipts=await listApprovalHistory(root,id);
  const review=await artifactReview(root,id,state);
  const sources=[], missing=[];
  for(const name of names) {
    const stage=STAGES.find(s=>DOCUMENTS[s].includes(name));
    const approval=receipts.find(a=>a.boardId===id && a.stage===stage && a.id===state.stageData[stage]?.approvalId);
    if(!state.stageData[stage]?.confirmed || !approval || JSON.stringify(approval.hashes)!==JSON.stringify(review.stages[stage].hashes)) {missing.push(name);continue;}
    const artifact=approval.artifacts.find(a=>a.name===name);
    if(!artifact) {missing.push(name);continue;}
    if(artifact.snapshot!==`${boardDirectory(id)}/snapshots/${artifact.contentHash}`)throw new Error('无效的文档快照路径');
    const bytes=await readFile(await managedPath(root,artifact.snapshot));
    if(sha256(bytes)!==artifact.contentHash)throw new Error('已确认文档快照校验失败，请检查处理记录');
    sources.push({name,text:bytes.toString('utf8'),approvalId:approval.id,revision:artifact.revision,contentHash:artifact.contentHash});
  }
  return {sources,missing};
}
