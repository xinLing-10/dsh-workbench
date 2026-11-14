/** Only this control-plane service resolves the model credential. No retries. */
import {budgetedMessage} from './budgeted-model.mjs';
import {SERVICE_TOOLS} from './service-budget.mjs';
export function createModelGateway({budget,model,resolveToken,attribution={},fetchImpl=globalThis.fetch}) {
 if(!model || typeof resolveToken!=='function')throw Error('Explicit model and private credential resolver required');
 return {async message({operationId,id,body,signal,authorizeDispatch}) {
  if(body?.model!==model)throw Object.assign(new Error('模型不在当前服务授权范围内'),{status:400});
  const result=await budgetedMessage({id,body,budget:budget.forOperation(operationId),resolveToken,attribution,fetchImpl,signal,authorizeDispatch,toolNames:SERVICE_TOOLS});
  // The wire contains model content and usage, never account headers/tokens.
  return {wire:result.wire,record:{id:result.record.id,status:result.record.status,usage:result.record.usage,complete:result.record.complete}};
 }};
}
