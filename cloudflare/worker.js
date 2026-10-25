/* KAC background job alarms. Cloudflare Durable Objects Free (SQLite-backed).
 * Secrets NEVER contain Kick credentials: only a shared gateway secret.
 * Deploy this Worker separately to Cloudflare; Vercel remains the Kick gateway.
 */
import { DurableObject } from 'cloudflare:workers';
const response = (value,status=200) => Response.json(value,{status,headers:{'Cache-Control':'no-store'}});
function equal(a,b){if(!a||!b||a.length!==b.length)return false;let v=0;for(let i=0;i<a.length;i++)v|=a.charCodeAt(i)^b.charCodeAt(i);return v===0;}
function goodId(x){return /^[a-zA-Z0-9_-]{12,120}$/.test(String(x||''));}
export class KacSchedule extends DurableObject {
  async fetch(req){
    if(req.method!=='POST')return response({ok:false,error:'POST required'},405);
    const b=await req.json().catch(()=>null);
    if(!b||!goodId(b.sid)||!goodId(b.id))return response({ok:false,error:'Invalid identifiers'},400);
    if(b.active!==true){await this.ctx.storage.deleteAlarm();await this.ctx.storage.delete('job');return response({ok:true,active:false});}
    const due=Math.max(Date.now()+1000,Number(b.nextAt)||Date.now()+1500);
    if(!Number.isFinite(due))return response({ok:false,error:'Invalid due time'},400);
    await this.ctx.storage.put('failureCount',0);await this.ctx.storage.put('job',{sid:b.sid,id:b.id,nextAt:due});
    await this.ctx.storage.setAlarm(due);
    return response({ok:true,active:true,nextAt:due});
  }
  async alarm(){
    const j=await this.ctx.storage.get('job');if(!j)return;
    try{
      const r=await fetch(this.env.VERCEL_BACKGROUND_ENDPOINT,{
        method:'POST',headers:{'Content-Type':'application/json','x-kac-worker-secret':this.env.BACKGROUND_WORKER_SECRET},body:JSON.stringify({sid:j.sid,id:j.id}),redirect:'error'
      });
      const result=await r.json();
      if(!r.ok||!result.ok)throw Error(result.error||'Gateway unavailable');
      if(result.running===true&&Number.isFinite(result.nextAt)&&result.nextAt>Date.now()-1000){
        const due=Math.max(Date.now()+1000,result.nextAt);
        await this.ctx.storage.put('job',{...j,nextAt:due});await this.ctx.storage.put('failureCount',0);await this.ctx.storage.setAlarm(due);
      }else{await this.ctx.storage.delete('job');await this.ctx.storage.deleteAlarm();}
    }catch(e){
      // Ambiguous requests are never blindly replayed by the gateway: its
      // persistent in-flight journal prevents repeating an uncertain send.
      const attempts=(await this.ctx.storage.get('failureCount')||0)+1;
      await this.ctx.storage.put('failureCount',attempts);
      await this.ctx.storage.setAlarm(Date.now()+Math.min(300000,15000*2**Math.min(attempts,5)));
    }
  }
}
export default {
  async fetch(request,env){
    if(request.method!=='POST')return response({ok:false,error:'POST required'},405);
    const expected=String(env.BACKGROUND_WORKER_SECRET||'');
    if(expected.length<32||!equal(String(request.headers.get('x-kac-worker-secret')||''),expected))return response({ok:false,error:'Forbidden'},403);
    const b=await request.json().catch(()=>null);
    if(b?.action==='probe')return response({ok:true,durableObject:!!env.KAC_SCHEDULES&&typeof env.KAC_SCHEDULES.idFromName==='function'});
    if(!b||!goodId(b.sid)||!goodId(b.id)||typeof b.active!=='boolean')return response({ok:false,error:'Invalid payload'},400);
    const key=env.KAC_SCHEDULES.idFromName(b.sid+'/'+b.id);
    const stub=env.KAC_SCHEDULES.get(key);
    return stub.fetch('https://do.internal/job',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});
  }
};
