/** One board state and its navigation projection; no second stage state machine. */
import {mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';
import {managedPath,atomicJson,boardDirectory} from './artifacts.js';
import {boardSummary} from './project-state.js';
export async function persistBoardRecord(root,index,id,state,name='') {
  boardDirectory(id);
  if(index?.version!==1 || !Array.isArray(index.boards))throw new Error('需求目录记录不兼容，请先修复，原记录未覆盖。');
  const file=await managedPath(root,`.dsh/workbench/boards/${id}.json`);
  const roster=await managedPath(root,'.dsh/workbench/boards.json');
  await mkdir(dirname(file),{recursive:true});
  const revision=state.stateRevision;
  state.stateRevision=(Number.isSafeInteger(revision) && revision>=0?revision:0)+1;
  await atomicJson(file,state);
  const summary=boardSummary(id,state,name);
  const existing=index.boards.findIndex(board=>board.id===id);
  if(existing<0)index.boards.unshift(summary);else index.boards[existing]=summary;
  index.boards=index.boards.slice(0,100);
  await atomicJson(roster,{version:1,activeId:index.activeId || id,boards:index.boards});
  return summary;
}
