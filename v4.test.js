'use strict';
/* Node-only integration fixture tests: no real Kick requests or accounts involved. */
const assert=require('node:assert/strict');
const {Readable}=require('node:stream');
const handler=require('./api/index.js');
process.env.SESSION_SECRET='testing-only-strong-secret-012345678901234567890123456789';
process.env.KICK_CLIENT_ID='test-client';process.env.KICK_CLIENT_SECRET='test-secret';
process.env.KICK_REDIRECT_URI='https://example.test/api?action=callback';
process.env.UPSTASH_REDIS_REST_URL='https://redis.test';process.env.UPSTASH_REDIS_REST_TOKEN='test';
process.env.BACKGROUND_WORKER_URL='https://worker.test/';process.env.BACKGROUND_WORKER_SECRET='unit-test-strong-worker-secret-abcdefghijklmnopqrstuvwxyz';
const store=new Map(),sets=new Map(),invokes=[];let sendCount=0;
global.fetch=async(url,o={})=>{
 const u=String(url);let data={};let status=200;
 if(u.includes('redis.test')){
   const a=JSON.parse(o.body||'[]'),[cmd,key,...args]=a;
   if(cmd==='SET'){
     if(a.includes('NX')&&store.has(key))data={result:null};else{store.set(key,args[0]);data={result:'OK'}}
   }else if(cmd==='GET')data={result:store.get(key)||null};
   else if(cmd==='DEL'){store.delete(key);data={result:1}}
   else if(cmd==='SADD'){const s=sets.get(key)||new Set();s.add(args[0]);sets.set(key,s);data={result:1}}
   else if(cmd==='SMEMBERS')data={result:[...(sets.get(key)||new Set())]};
   else if(cmd==='SREM'){sets.get(key)?.delete(args[0]);data={result:1}}
   else data={result:1};
 }else if(u.includes('worker.test')){invokes.push(JSON.parse(o.body||'{}'));data={ok:true}}
 else if(u.includes('/oauth/token/introspect'))data={data:{active:true,token_type:'user',client_id:'test-client',scope:'user:read channel:read chat:write',exp:Math.floor(Date.now()/1000)+3600}};
 else if(u.includes('/oauth/token'))data={access_token:'TEST_ACCESS_TOKEN_VALID_ABC123456789',refresh_token:'TEST_REFRESH_VALID_ABC123456789',scope:'user:read channel:read chat:write',expires_in:3600};
 else if(u.includes('/public/v1/users'))data={data:[{user_id:151,username:'Sample User',name:'test_account'}]};
 else if(u.includes('/public/v1/channels?'))data={data:[{slug:'streamer',broadcaster_user_id:42,stream:{is_live:true}}]};
 else if(u.includes('/public/v1/chat')){sendCount++;data={data:{is_sent:true}}}
 else data={data:{}};
 return {ok:status>=200&&status<300,status,text:async()=>JSON.stringify(data)};
};
async function run(method,path,{cookie='',body,headers={}}={}){
 const payload=body===undefined?'':typeof body==='string'?body:JSON.stringify(body);const req=Readable.from([payload]);req.method=method;req.url=path;req.headers={host:'example.test',cookie,...headers};
 const hs={};let raw='';const res={statusCode:200,setHeader(k,v){hs[k]=v},getHeader(k){return hs[k]},end(v=''){raw+=String(v)}};await handler(req,res);
 let data;try{data=JSON.parse(raw)}catch{data={}}
 return {status:res.statusCode,data,headers:hs};
}
const cks=x=>(x.headers['Set-Cookie']||[]).map(s=>s.split(';')[0]).join('; ');
(async()=>{
 let r=await run('GET','/api?action=auth');const oauthCookie=cks(r),state=new URL(r.headers.Location).searchParams.get('state');
 r=await run('GET','/api?action=callback&code=testing&state='+state,{cookie:oauthCookie});assert.equal(r.status,302);
 const sidCookie=cks(r);assert.match(sidCookie,/kac_sid=/);
 r=await run('GET','/api?action=me',{cookie:sidCookie});assert.equal(r.data.background,true);const csrf=r.data.csrf;
 const authed=(action,body)=>run('POST','/api?action='+action,{cookie:sidCookie,body,headers:{'x-kac-csrf':csrf}});
 const j={id:'test-job-0123456789',name:'Saved Draft',account:'151',slug:'streamer',messages:['hello'],mode:'ordered',randomDelay:false,intervalMs:3000,delayMinMs:3000,delayMaxMs:7000,count:null,startAt:null,endAt:null,status:'draft'};
 r=await authed('job_command',{command:'create',job:j});assert.equal(r.status,200);assert.equal(r.data.job.status,'draft');assert.equal(invokes.at(-1).active,false);
 r=await run('GET','/api?action=jobs',{cookie:sidCookie});assert.equal(r.data.jobs.length,1);
 r=await authed('job_command',{command:'start',id:j.id});assert.equal(r.data.job.status,'running');assert.equal(invokes.at(-1).active,true);
 const sid=sidCookie.match(/kac_sid=([^;\s]+)/)[1];const key='kac:job:'+sid+':'+j.id;
 let onDisk=JSON.parse(store.get(key));onDisk.nextAt=Date.now()-10;store.set(key,JSON.stringify(onDisk));
 r=await run('POST','/api?action=background_execute',{body:{sid,id:j.id},headers:{'x-kac-worker-secret':process.env.BACKGROUND_WORKER_SECRET}});
 assert.equal(r.status,200);assert.equal(r.data.running,true);assert.equal(sendCount,1);
 onDisk=JSON.parse(store.get(key));assert.equal(onDisk.sent,1);assert.equal(onDisk.count,null);assert.ok(onDisk.nextAt>Date.now());
 r=await authed('job_command',{command:'pause',id:j.id});assert.equal(r.status,200);assert.equal(invokes.at(-1).active,false);
 r=await run('POST','/api?action=background_execute',{body:{sid,id:j.id},headers:{'x-kac-worker-secret':'wrong'}});assert.equal(r.status,403);
 r=await authed('backup_export',{passphrase:'my strong backup passphrase 2026',local:{channels:[],notes:[],jobs:[j],accountConfigs:{},prefs:{lang:'ar'}}});
 assert.equal(r.status,200);assert.match(r.data.code,/^KAC4\./);assert.equal(r.data.code.includes('TEST_ACCESS_TOKEN'),false);const code=r.data.code;
 let rr=await authed('backup_import',{code,passphrase:'invalid password'});assert.equal(rr.status,400);
 rr=await authed('backup_import',{code,passphrase:'my strong backup passphrase 2026'});assert.equal(rr.status,200);assert.equal(rr.data.accounts.length,1);assert.equal(rr.data.local.jobs.length,1);
 const sid2=cks(rr);assert.ok(sid2);
 const accTest=await run('POST','/api?action=import_token',{cookie:sidCookie,headers:{'x-kac-csrf':rr.data.csrf},body:{access_token:'123|SESSIONS'}});assert.equal(accTest.status,400);
 console.log('PASS KAC v4: background alarms job create/start/execute/stop, 3s delay, unlimited count, encrypted full backup/restore, token formats, denied invalid worker secret');
})().catch(e=>{console.error(e);process.exitCode=1});
