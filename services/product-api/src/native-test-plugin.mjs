/** Test-only native tool. No model-controlled paths, shell, network or dependencies. */
import{writeFile}from'node:fs/promises';import{join}from'node:path';
import{apply as bridgeApply}from'../../worker-bridge/index.mjs';
import{installation}from'./current-deepseek-account.mjs';
const{defineTool}=await import(installation+'/node_modules/@deepseek-ai/dsh-tools/lib/index.js');
export const name='manager-native-test';export const inject=['tools','approval','userQuestions'];
export function apply(ctx,config){let activeAgent;
 const remember=(request,next)=>{activeAgent=request.agent;process.send?.({type:'native_wait',kind:request.toolName?'permission':'question'});return next();};
 ctx.on('approval/request',remember);ctx.on('user-questions/request',remember);
 bridgeApply(ctx,{...config.bridge,enabled:true,approvalTimeoutMs:60000,questionTimeoutMs:60000});
 const listener=message=>{if(message?.type==='cancel-native'&&activeAgent){activeAgent.cancel({kind:'user'});process.send?.({type:'cancel-requested'});}};
 process.on('message',listener);process.channel?.unref();ctx.on('dispose',()=>process.off('message',listener));
 ctx.tools.register(defineTool({name:'manager_test_note',description:'Request permission to write a fixed synthetic test note. The note is written only after an explicit allowed-once decision. No path argument.',parameters:{},output:{schema:{type:'object',additionalProperties:false,properties:{status:{type:'string',required:true},written:{type:'boolean',required:true}}},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},async execute(_args,exec){
  activeAgent=exec.agent;const outcome=await ctx.approval.request({agent:exec.agent,toolName:'manager_test_note',callId:exec.callId,reason:'仅在独立测试目录写入固定便笺，用于验证拒绝能否阻止实际写入。',signal:exec.signal});
  await writeFile(join(config.workspace,'approval-outcome.json'),JSON.stringify({outcome,callId:exec.callId}),{mode:0o600});
  if(outcome!=='allowed-once'||exec.signal.aborted)return{status:outcome,written:false};
  await writeFile(join(config.workspace,'test-note.txt'),'Synthetic native approval test note.',{flag:'wx',mode:0o600});return{status:outcome,written:true};
 }}));
}
