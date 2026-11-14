import {createInvite,createTenant} from './auth.mjs';
import {auditService} from './service-budget.mjs';
const invalid=(message,status=400)=>Object.assign(new Error(message),{status,code:'validation'});
export function invitationOverview(db,config){return {enabled:Boolean(config.allowRedeem),tenants:db.prepare('SELECT id,name FROM tenants ORDER BY created_at DESC').all(),invitations:db.prepare('SELECT i.id,i.tenant_id tenantId,t.name tenantName,i.created_at createdAt,i.expires_at expiresAt,i.redeemed_at redeemedAt,u.email redeemedBy FROM invites i JOIN tenants t ON t.id=i.tenant_id LEFT JOIN users u ON u.id=i.redeemed_by ORDER BY i.created_at DESC,i.id DESC LIMIT 100').all().map(i=>({...i,status:i.redeemedAt?'used':Date.parse(i.expiresAt)<=Date.now()?'expired':'available'}))};}
export function issueInvitation(db,config,actor,body){
 if(!config.allowRedeem)throw invalid('邀请兑换尚未开放，请由运维先配置 PRODUCT_API_ALLOW_REDEEM=1。生成操作不会修改开关。',409);
 if(!body||!['new','existing'].includes(body.mode))throw invalid('请选择新建独立租户或已有租户');
 if(!Number.isInteger(body.hours)||body.hours<1||body.hours>168)throw invalid('有效期必须为 1 到 168 小时');
 if(body.mode==='new'&&(typeof body.name!=='string'||!body.name.trim()||body.name.trim().length>80))throw invalid('请输入不超过80字的租户名称');
 if(body.mode==='existing'&&(typeof body.tenantId!=='string'||body.confirmShared!==true))throw invalid('加入已有租户前，请确认会共享其项目，且当前账号角色为租户负责人');
 db.exec('BEGIN IMMEDIATE');try{
  const tenant=body.mode==='new'?createTenant(db,{name:body.name.trim()}):db.prepare('SELECT id,name FROM tenants WHERE id=?').get(body.tenantId);
  if(!tenant)throw invalid('租户不存在',404);
  const invite=createInvite(db,{tenantId:tenant.id,ttlMs:body.hours*3600000});
  auditService(db,actor,'invitation_created',invite.id,{tenantId:tenant.id,tenantName:tenant.name,expiresAt:invite.expiresAt,mode:body.mode});
  db.exec('COMMIT');return {...invite,tenantId:tenant.id,tenantName:tenant.name};
 }catch(error){db.exec('ROLLBACK');throw error;}
}
