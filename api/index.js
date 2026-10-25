'use strict';
/* KAC 2026 - Official Kick API serverless gateway, no dependencies. Node 20+. */
const crypto = require('node:crypto');
const KICK = 'https://api.kick.com', AUTH = 'https://id.kick.com';
const SCOPE = 'user:read channel:read chat:write channel:rewards:read';
const enc = (x) => Buffer.from(x).toString('base64url');
const rand = (n=32) => crypto.randomBytes(n).toString('base64url');
const secret = () => {
  const s = process.env.SESSION_SECRET || '';
  if (s.length < 32) throw Object.assign(new Error('SESSION_SECRET must be at least 32 characters.'),{status:503});
  return crypto.createHash('sha256').update(s).digest();
};
const cookie = (req,name) => (req.headers.cookie || '').split(';').map(x=>x.trim()).find(x=>x.startsWith(name+'='))?.slice(name.length+1) || '';
function seal(obj) {
  const iv=crypto.randomBytes(12), cipher=crypto.createCipheriv('aes-256-gcm',secret(),iv);
  const data=Buffer.concat([cipher.update(JSON.stringify(obj)),cipher.final()]);
  return Buffer.concat([iv,cipher.getAuthTag(),data]).toString('base64url');
}
function unseal(value) {
  if(!value)return null;
  try{const b=Buffer.from(value,'base64url'); if(b.length<30)return null;
    const decipher=crypto.createDecipheriv('aes-256-gcm',secret(),b.subarray(0,12));decipher.setAuthTag(b.subarray(12,28));
    const v=JSON.parse(Buffer.concat([decipher.update(b.subarray(28)),decipher.final()]).toString('utf8'));
    if(v.exp && v.exp < Date.now())return null;return v;
  }catch{return null}
}
function setCookie(res,name,value,age){
  const s=`${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`;
  const a=res.getHeader('Set-Cookie')||[];res.setHeader('Set-Cookie',[...a,s]);
}
function json(res,status,obj){res.statusCode=status;res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store');res.end(JSON.stringify(obj))}
function failure(res,e){let code=Number(e.status)||500; if(code<400||code>599)code=500;
  json(res,code,{ok:false,error:code>=500 && code!==503?'حدث خطأ بالخادم.':e.message||'خطأ غير معروف',code,upstreamStatus:e.upstreamStatus||null});}
function err(message,status=400){return Object.assign(new Error(message),{status})}
function safeOrigin(req){const origin=req.headers.origin;const host=req.headers.host;if(origin && new URL(origin).host!==host)throw err('Origin غير مسموح',403)}
function requireCsrf(req,s){safeOrigin(req);if(!s||!s.csrf||req.headers['x-kac-csrf']!==s.csrf)throw err('انتهت صلاحية جلسة الحماية. حدّث الصفحة.',403)}
async function readBody(req){if(req.body && typeof req.body==='object' && !Buffer.isBuffer(req.body))return req.body;
  const raw=await new Promise((resolve,reject)=>{let d='';req.on('data',c=>{d+=c;if(d.length>1600000){reject(err('البيانات أكبر من المسموح',413));req.destroy()}});req.on('end',()=>resolve(d));req.on('error',reject)});
  try{return JSON.parse(raw||'{}')}catch{throw err('JSON غير صالح',400)}
}
async function outbound(url,{method='GET',headers={},body,timeout=11000}={}){
  const c=new AbortController(),t=setTimeout(()=>c.abort(),timeout);
  try{const r=await fetch(url,{method,headers,body,signal:c.signal,redirect:'error'});
    const raw=await r.text();let data;try{data=JSON.parse(raw)}catch{data={message:raw.slice(0,180)}};
    if(!r.ok){const x=err((data?.message||data?.error_description||data?.error||`Kick HTTP ${r.status}`).toString().slice(0,250),r.status===429?429:r.status===401?401:r.status===403?403:r.status===404?404:502);x.upstreamStatus=r.status;throw x}
    return data;
  }catch(e){if(e.name==='AbortError')throw err('انتهت مهلة اتصال Kick؛ نتيجة العملية غير مؤكدة، لن نعيد الإرسال تلقائيًا.',504);throw e}finally{clearTimeout(t)}
}
let appCache={token:'',exp:0};
const localSendCooldown=new Map(); // Best effort per instance; Redis is needed for distributed protection.
async function appToken(){if(appCache.exp>Date.now()+30000)return appCache.token;
  if(!process.env.KICK_CLIENT_ID||!process.env.KICK_CLIENT_SECRET)throw err('لم يتم ضبط مفاتيح تطبيق Kick على السيرفر.',503);
  const b=new URLSearchParams({grant_type:'client_credentials',client_id:process.env.KICK_CLIENT_ID,client_secret:process.env.KICK_CLIENT_SECRET});
  const r=await outbound(AUTH+'/oauth/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:b.toString()});
  if(!r.access_token)throw err('لم يرجع Kick توكن التطبيق',502);appCache={token:r.access_token,exp:Date.now()+(Number(r.expires_in)||600)*1000};return r.access_token;
}
async function kickGet(path,token){return outbound(KICK+path,{headers:{Authorization:'Bearer '+token,Accept:'application/json'}})}
async function kickPost(path,token,value){return outbound(KICK+path,{method:'POST',headers:{Authorization:'Bearer '+token,Accept:'application/json','Content-Type':'application/json'},body:JSON.stringify(value)})}
const normalizeSlug = s => {let v=String(s||'').trim();if(/\s/.test(v))return '';v=v.replace(/^https?:\/\/(?:www\.)?kick\.com\//i,'').replace(/^@/,'').split(/[\/?#\s]/)[0].toLowerCase();return /^[a-z0-9_-]{1,25}$/.test(v)?v:''};
const SESSION_TTL=30*86400;
async function loadSession(req){
  const sid=cookie(req,'kac_sid');
  if(redisEnabled()&&/^[A-Za-z0-9_-]{24,100}$/.test(sid)){
    const packed=await redis('GET','kac:session:'+sid);
    const active=unseal(packed);
    if(active){active._sid=sid;return active}
    // Never trust a stale session cookie: rotate CSRF rather than reusing an expired session.
  }
  return unseal(cookie(req,'kac_session'))||{accounts:[],csrf:rand(24)};
}
async function saveSession(res,s){
  s.exp=Date.now()+SESSION_TTL*1000;
  if(redisEnabled()){
    const sid=s._sid||rand(32);delete s._sid;
    const packed=seal(s);
    await redis('SET','kac:session:'+sid,packed,'EX',SESSION_TTL);
    s._sid=sid;setCookie(res,'kac_sid',sid,SESSION_TTL);
    setCookie(res,'kac_session','',0);
    return;
  }
  const v=seal(s);
  if(v.length>3750)throw err('جلسة الحسابات امتلأت؛ فعّل Upstash Redis لاستيعاب حسابات أكثر بأمان.',413);
  setCookie(res,'kac_session',v,SESSION_TTL);
}
async function accountToken(s,account){const a=(s?.accounts||[]).find(x=>String(x.id)===String(account));if(!a)throw err('اختار حساب متصل أولاً',401);
  if(a.expires>Date.now()+60000)return a;
  if(!a.refresh_token)throw err('جلسة Kick انتهت؛ سجّل دخولك تاني',401);
  const b=new URLSearchParams({grant_type:'refresh_token',client_id:process.env.KICK_CLIENT_ID,client_secret:process.env.KICK_CLIENT_SECRET,refresh_token:a.refresh_token});
  const d=await outbound(AUTH+'/oauth/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:b.toString()});
  if(!d.access_token)throw err('فشل تجديد صلاحية الحساب',401);
  a.access_token=d.access_token;a.refresh_token=d.refresh_token||a.refresh_token;a.expires=Date.now()+Number(d.expires_in||3600)*1000;a.scope=d.scope||a.scope;return a;
}
function publicAccounts(s){return (s.accounts||[]).map(a=>({id:a.id,username:a.username,avatar:a.avatar||'',expires:a.expires,scope:a.scope,renewable:!!a.refresh_token}));}
async function redis(...args){const base=process.env.UPSTASH_REDIS_REST_URL,token=process.env.UPSTASH_REDIS_REST_TOKEN;
  if(!base||!token)throw err('الشات المباشر يحتاج إعداد تخزين Redis وإشعارات Kick Webhooks.',503);
  const r=await outbound(base.replace(/\/$/,'')+'/',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(args),timeout:7000});
  if(r.error)throw err('خطأ التخزين',502);return r.result;
}
const redisEnabled = ()=>!!(process.env.UPSTASH_REDIS_REST_URL&&process.env.UPSTASH_REDIS_REST_TOKEN);
async function handleWebhook(req,res){
  if(req.method!=='POST')throw err('الطريقة غير مسموحة',405);
  // Never touch req.body here: Vercel parses it lazily and may consume the raw stream.
  const raw=await new Promise((resolve,reject)=>{let b='';req.on('data',c=>{b+=c;if(b.length>300000){reject(err('كبير جداً',413));req.destroy()}});req.on('end',()=>resolve(b));req.on('error',reject)});
  const id=String(req.headers['kick-event-message-id']||''),ts=String(req.headers['kick-event-message-timestamp']||''),sig=String(req.headers['kick-event-signature']||'');
  if(!id||!ts||!sig||!Number.isFinite(Date.parse(ts))||Math.abs(Date.now()-Date.parse(ts))>10*60*1000)throw err('توقيع الحدث مفقود أو قديم',401);
  const pub=await outbound(KICK+'/public/v1/public-key',{timeout:7000});
  const pem=typeof pub==='string'?pub:(pub?.data?.public_key||pub?.data?.publicKey||pub?.public_key||pub?.data||'');
  if(typeof pem!=='string'||!pem.includes('BEGIN PUBLIC KEY'))throw err('تعذّر الحصول على مفتاح التحقق',502);
  let valid=false;try{const v=crypto.createVerify('RSA-SHA256');v.update(`${id}.${ts}.${raw}`);v.end();valid=v.verify(pem,Buffer.from(sig,'base64'))}catch{}
  if(!valid)throw err('توقيع Kick غير صحيح',401);
  if(!redisEnabled())return json(res,503,{ok:false,error:'Webhooks require persistent Redis storage'});
  const typ=String(req.headers['kick-event-type']||'');let b;try{b=JSON.parse(raw)}catch{throw err('حدث JSON غير صالح')}
  const broadcaster=Number(b?.broadcaster?.user_id||b?.broadcaster_user_id||0);
  if(!Number.isSafeInteger(broadcaster)||broadcaster<=0)return json(res,200,{ok:true,ignored:true});
  if(['chat.message.sent','livestream.status.updated','livestream.metadata.updated'].includes(typ)){
    const msg={id:String(b.message_id||id),kind:typ,timestamp:b.created_at||ts,sender:b.sender||{},content:String(b.content||''),replies_to:b.replies_to||null,emotes:Array.isArray(b.emotes)?b.emotes.slice(0,100):[],stream:b.is_live===true?true:b.is_live===false?false:null,title:String(b.title||'')};
    const lua="if redis.call('SET',KEYS[1],'1','EX',86400,'NX') then redis.call('LPUSH',KEYS[2],ARGV[1]); redis.call('LTRIM',KEYS[2],0,349); redis.call('EXPIRE',KEYS[2],172800); return 1 else return 0 end";
    const inserted=await redis('EVAL',lua,2,'kac:event:'+id,'kac:chat:'+broadcaster,JSON.stringify(msg));
    return json(res,200,{ok:true,duplicate:inserted===0});
  }
  return json(res,200,{ok:true,ignored:true});
}

// Background scheduler: Redis is authoritative, Cloudflare Durable Object alarms wake jobs.
// Tokens remain encrypted on Vercel; the Worker receives only opaque session/job IDs.
const jobKey=(sid,id)=>'kac:job:'+sid+':'+id;
const validId=id=>/^[a-zA-Z0-9_-]{12,120}$/.test(String(id||''));
const backgroundEnabled=()=>redisEnabled()&&!!(process.env.BACKGROUND_WORKER_URL&&process.env.BACKGROUND_WORKER_SECRET);
function sharedAuth(req){
 const provided=String(req.headers['x-kac-worker-secret']||'');const expected=String(process.env.BACKGROUND_WORKER_SECRET||'');
 if(!expected||expected.length<32||provided.length!==expected.length||!crypto.timingSafeEqual(Buffer.from(provided),Buffer.from(expected)))throw err('غير مصرح',403);
}
function validateJob(b){
 if(!b||typeof b!=='object'||!validId(b.id)||!/^[0-9]{1,24}$/.test(String(b.account||'')))throw err('بيانات جدول غير صحيحة');
 const slug=normalizeSlug(b.slug),messages=Array.isArray(b.messages)?b.messages:[];
 if(!slug||messages.length<1||messages.length>100||messages.some(t=>typeof t!=='string'||!t.trim()||[...t].length>500||Buffer.byteLength(t)>2048))throw err('رسائل الجدول غير صالحة');
 const interval=Number(b.intervalMs),lo=Number(b.delayMinMs),hi=Number(b.delayMaxMs);
 if(!Number.isSafeInteger(interval)||interval<3000||interval>3600000||!Number.isSafeInteger(lo)||lo<3000||lo>3600000||!Number.isSafeInteger(hi)||hi<lo||hi>3600000)throw err('الفاصل من 3 إلى 3600 ثانية');
 const count=b.count===null?null:Number(b.count);
 if(count!==null&&(!Number.isSafeInteger(count)||count<1||count>1000000))throw err('عدد الرسائل غير صحيح');
 return {id:String(b.id),name:String(b.name||'جدول').slice(0,80),account:String(b.account),slug,messages:messages.map(x=>x.trim()),mode:b.mode==='random'?'random':'ordered',intervalMs:interval,randomDelay:b.randomDelay===true,delayMinMs:lo,delayMaxMs:hi,count,startAt:b.startAt===null?null:Number(b.startAt)||Date.now(),endAt:b.endAt?Number(b.endAt):null,createdAt:Number(b.createdAt)||Date.now(),sent:0,failed:0,uncertain:0,attempted:0,index:0,status:'draft',nextAt:null,log:[],inflight:false,lastError:'',sendOffline:b.sendOffline===true,startedAt:Number(b.startedAt)||null,parentPaused:false};
}
async function loadPersistedJob(sid,id){const raw=await redis('GET',jobKey(sid,id));if(!raw)return null;try{return JSON.parse(raw)}catch{return null}}
async function persistJob(sid,j){await redis('SET',jobKey(sid,j.id),JSON.stringify(j),'EX',SESSION_TTL);await redis('SADD','kac:jobs:'+sid,j.id);await redis('EXPIRE','kac:jobs:'+sid,SESSION_TTL)}
async function workerControl(sid,id,active,nextAt){
 if(!backgroundEnabled())throw err('ربط مشغل Cloudflare مطلوب لاستمرار الجدولة بالخلفية',503);
 const base=new URL(process.env.BACKGROUND_WORKER_URL);
 if(base.protocol!=='https:')throw err('BACKGROUND_WORKER_URL must use HTTPS',503);
 const r=await outbound(base.href,{method:'POST',headers:{'Content-Type':'application/json','x-kac-worker-secret':process.env.BACKGROUND_WORKER_SECRET},body:JSON.stringify({sid,id,active:!!active,nextAt:nextAt||Date.now()}),timeout:12000});
 if(r.ok!==true)throw err('مشغل الخلفية لم يقبل الجدول',502);
}
async function loadFromSid(sid){if(!redisEnabled()||!/^[A-Za-z0-9_-]{24,100}$/.test(String(sid||'')))throw err('جلسة غير صالحة',401);
 const packed=await redis('GET','kac:session:'+sid);const s=unseal(packed);if(!s)throw err('انتهت صلاحية الجلسة',401);s._sid=sid;return s}
async function saveForSid(s){const sid=s._sid;if(!sid)throw err('جلسة بلا تخزين',503);
 const out={...s};delete out._sid;out.exp=Date.now()+SESSION_TTL*1000;
 await redis('SET','kac:session:'+sid,seal(out),'EX',SESSION_TTL);
}
function randDelay(j){const lo=j.randomDelay?j.delayMinMs:j.intervalMs,hi=j.randomDelay?j.delayMaxMs:j.intervalMs;
 return lo===hi?lo:lo+crypto.randomInt(0,hi-lo+1)}
async function backgroundExecute(req,res){sharedAuth(req);if(req.method!=='POST')throw err('method',405);const b=await readBody(req),sid=String(b.sid||''),id=String(b.id||'');
 if(!validId(id))throw err('معرّف غير صالح');const s=await loadFromSid(sid);
 if(id==='session_refresh'){
  if(!s.accounts?.length)return json(res,200,{ok:true,running:false,reason:'no accounts'});
  let renewed=0;for(const a of s.accounts||[]){if(a.refresh_token&&a.expires<Date.now()+45*60*1000){try{await accountToken(s,a.id);renewed++}catch(e){a.lastRefreshError=e.message}}}
  await saveForSid(s);return json(res,200,{ok:true,running:true,nextAt:Date.now()+30*60*1000,renewed});
 }
 const j=await loadPersistedJob(sid,id);
 if(!j)return json(res,200,{ok:true,running:false,reason:'deleted'});
 if(!['running','pending'].includes(j.status))return json(res,200,{ok:true,running:false,reason:j.status});
 const now=Date.now();if(j.nextAt&&now+250<j.nextAt)return json(res,200,{ok:true,running:true,nextAt:j.nextAt});
 if(j.endAt&&now>=j.endAt){j.status='stopped';await persistJob(sid,j);return json(res,200,{ok:true,running:false,reason:'time ended'})}
 if(j.count!==null&&j.attempted>=j.count){j.status='completed';await persistJob(sid,j);return json(res,200,{ok:true,running:false})}
 const k='kac:joblock:'+sid+':'+id;
 if(await redis('SET',k,'1','EX',40,'NX')!=='OK')return json(res,200,{ok:true,running:true,nextAt:Date.now()+15000});
 if(j.inflight){j.status='paused';j.lastError='طلب سابق نتيجته غير مؤكدة؛ أوقف الجدول لمراجعة السجل';await persistJob(sid,j);return json(res,200,{ok:true,running:false,reason:j.lastError})}
 j.startedAt ||= Date.now();const ix=j.mode==='random'?crypto.randomInt(j.messages.length):j.index%j.messages.length,content=j.messages[ix];
 j.index++;j.attempted++;j.inflight=true;j.nextAt=null;j.status='running';await persistJob(sid,j);
 try{
  const a=await accountToken(s,j.account);
  if(!String(a.scope||'').split(/\s+/).includes('chat:write'))throw err('صلاحية chat:write غير متاحة',403);
  const t=await appToken(),ch=await kickGet('/public/v1/channels?slug='+encodeURIComponent(j.slug),t),channel=ch.data?.[0],br=Number(channel?.broadcaster_user_id);
  if(!Number.isSafeInteger(br)||br<=0)throw err('قناة غير متاحة');
  if(j.sendOffline!==true&&channel?.stream?.is_live!==true){
    j.index=Math.max(0,j.index-1);j.attempted=Math.max(0,j.attempted-1);j.status='running';j.nextAt=Date.now()+90000;
    // No message sent and no failure: schedule a later, server-confirmed live-status check.
    return json(res,200,{ok:true,running:true,nextAt:j.nextAt,status:'waiting_for_live'});
  }
  const lock='kac:sendlock:'+j.account+':'+br;
  if(await redis('SET',lock,'1','EX',3,'NX')!=='OK')throw err('الفاصل بين الرسائل غير كافٍ للقناة',429);
  const r=await kickPost('/public/v1/chat',a.access_token,{type:'user',broadcaster_user_id:br,content});
  if(r.data?.is_sent!==true)throw err('Kick لم يؤكد قبول الرسالة',502);
  j.sent++;j.lastError='';j.nextAt=Date.now()+randDelay(j);
  if((j.count!==null&&j.attempted>=j.count)||(j.endAt&&j.nextAt>=j.endAt))j.status='completed';
 }catch(e){j.status='failed';j.lastError=String(e.message||'Unknown error').slice(0,250);
  if(e.status===504||e.status===502){j.uncertain++;}else j.failed++;
 }finally{
  j.inflight=false;const latest=await loadPersistedJob(sid,id);
  if(latest&&['paused','stopped'].includes(latest.status)){j.status=latest.status;j.nextAt=null}
  await persistJob(sid,j);await saveForSid(s);
 }
 return json(res,200,{ok:true,running:j.status==='running',nextAt:j.nextAt||null,status:j.status});
}
function encryptBackup(obj,passphrase){if(typeof passphrase!=='string'||passphrase.length<12||passphrase.length>300)throw err('كلمة المرور لازم تكون 12 حرفًا على الأقل');
 const salt=crypto.randomBytes(16),iv=crypto.randomBytes(12),key=crypto.pbkdf2Sync(passphrase,salt,310000,32,'sha256');
 const cipher=crypto.createCipheriv('aes-256-gcm',key,iv);const plain=Buffer.from(JSON.stringify(obj));
 if(plain.length>800000)throw err('حجم النسخة تجاوز الحد المسموح',413);
 const payload=Buffer.concat([cipher.update(plain),cipher.final()]);return 'KAC4.'+Buffer.concat([salt,iv,cipher.getAuthTag(),payload]).toString('base64url')}
function decryptBackup(code,passphrase){if(typeof code!=='string'||!/^KAC4\.[\w-]{20,1600000}$/.test(code)||typeof passphrase!=='string'||passphrase.length<12)throw err('صيغة كود النسخة أو كلمة المرور غير صحيحة');
 const bytes=Buffer.from(code.slice(5),'base64url');if(bytes.length<45)throw err('كود النسخة غير كامل');
 const key=crypto.pbkdf2Sync(passphrase,bytes.subarray(0,16),310000,32,'sha256');
 try{const d=crypto.createDecipheriv('aes-256-gcm',key,bytes.subarray(16,28));d.setAuthTag(bytes.subarray(28,44));
  const raw=Buffer.concat([d.update(bytes.subarray(44)),d.final()]);const x=JSON.parse(raw.toString('utf8'));
  if(x?.format!=='KAC-SECURE-V4'||!Array.isArray(x.accounts)||!x.local||typeof x.local!=='object')throw Error('format');return x;
 }catch{throw err('فشل فك التشفير: كلمة المرور أو الكود غير صحيح',400)}}
async function verifyUserAccess(token){
 if(typeof token!=='string'||token.length<20||token.length>2500||token.includes('|')||/\s/.test(token))throw err('توكن OAuth غير صالح؛ نوع ID|SESSION القديم غير مدعوم',400);
 const intro=await outbound(AUTH+'/oauth/token/introspect',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/x-www-form-urlencoded'}});
 const d=intro.data||{};if(d.active!==true||d.token_type!=='user')throw err('التوكن غير نشط أو ليس توكن مستخدم',401);
 if(String(d.client_id)!==String(process.env.KICK_CLIENT_ID))throw err('التوكن يخص تطبيق OAuth آخر؛ اربط الحساب عن طريق تسجيل الدخول الرسمي لهذا التطبيق',403);
 const u=await kickGet('/public/v1/users',token);const user=Array.isArray(u.data)?u.data[0]:u.data||{};
 const id=String(user.user_id||user.id||'');if(!/^\d{1,24}$/.test(id))throw err('لم يحدد Kick مستخدم التوكن');
 return {id,username:user.name||user.username||user.slug||id,avatar:user.profile_picture||user.profile_pic||'',access_token:token,scope:String(d.scope||''),expires:Number(d.exp)*1000||Date.now()+1800000};
}

module.exports=async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('X-Frame-Options','DENY');res.setHeader('Cache-Control','no-store');
  try{
    const url=new URL(req.url,'https://'+(req.headers.host||'localhost'));
    const action=url.searchParams.get('action')||'health';
    if(action==='webhook')return await handleWebhook(req,res);
    if(!['GET','POST'].includes(req.method))throw err('غير مسموح',405);
    if(action==='health')return json(res,200,{ok:true,configured:!!(process.env.KICK_CLIENT_ID&&process.env.KICK_CLIENT_SECRET&&process.env.SESSION_SECRET),chatStorage:redisEnabled(),background:backgroundEnabled(),version:'2026.10.v5'});
    if(action==='background_execute')return await backgroundExecute(req,res);
    let s=await loadSession(req);
    if(action==='diagnostics'){
      if(req.method!=='GET')throw err('method',405);
      const out={ok:true,configured:!!(process.env.KICK_CLIENT_ID&&process.env.KICK_CLIENT_SECRET&&process.env.SESSION_SECRET),chatStorage:redisEnabled(),background:backgroundEnabled(),version:'2026.10.v5',kick:{ok:false},redis:{ok:false},worker:{ok:false}};
      if(!process.env.KICK_CLIENT_ID||!process.env.KICK_CLIENT_SECRET)out.kick.error='بيانات Kick غير مكتملة';
      else try{const token=await appToken();const v=await outbound(AUTH+'/oauth/token/introspect',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/x-www-form-urlencoded'},timeout:7000});out.kick={ok:v?.data?.active===true,error:v?.data?.active===true?undefined:'Kick لم يؤكد أن توكن التطبيق نشط'}}catch(e){out.kick.error='تعذّر الحصول على توكن Kick: '+String(e.message||'').slice(0,90)}
      if(!redisEnabled())out.redis.error='Upstash غير مضبوطة';
      else try{const r=await redis('PING');out.redis={ok:r==='PONG',error:r==='PONG'?undefined:'Redis لم يرجع PONG'}}catch(e){out.redis.error='فشل الاتصال بـRedis: '+String(e.message||'').slice(0,90)}
      if(!process.env.BACKGROUND_WORKER_URL||!process.env.BACKGROUND_WORKER_SECRET)out.worker.error='متغيرات Cloudflare ناقصة';
      else try{const r=await outbound(new URL(process.env.BACKGROUND_WORKER_URL).href,{method:'POST',headers:{'Content-Type':'application/json','x-kac-worker-secret':process.env.BACKGROUND_WORKER_SECRET},body:JSON.stringify({action:'probe'}),timeout:7000});out.worker={ok:r.ok===true&&r.durableObject===true,error:r.ok===true&&r.durableObject===true?undefined:'Worker أو Durable Objects غير جاهزين'}}catch(e){out.worker.error='فشل الاتصال بـWorker: '+String(e.message||'').slice(0,90)}
      return json(res,200,out);
    }

    if(action==='auth'){
      if(req.method!=='GET')throw err('غير مسموح',405);
      if(!process.env.KICK_CLIENT_ID||!process.env.KICK_CLIENT_SECRET)throw err('أدخل مفاتيح Kick في إعدادات Vercel أولًا',503);
      const verifier=rand(32),state=rand(24),challenge=enc(crypto.createHash('sha256').update(verifier).digest());
      const callback=process.env.KICK_REDIRECT_URI;
      if(!/^https:\/\//.test(callback||''))throw err('KICK_REDIRECT_URI مطلوب كرابط HTTPS مطابق لإعداد Kick',503);
      setCookie(res,'kac_oauth',seal({verifier,state,callback,exp:Date.now()+600000}),600);
      const p=new URLSearchParams({response_type:'code',client_id:process.env.KICK_CLIENT_ID,redirect_uri:callback,scope:SCOPE,code_challenge:challenge,code_challenge_method:'S256',state});
      res.statusCode=302;res.setHeader('Location',AUTH+'/oauth/authorize?'+p.toString());return res.end();
    }
    if(action==='callback'){
      if(req.method!=='GET')throw err('غير مسموح',405);
      const tx=unseal(cookie(req,'kac_oauth'));setCookie(res,'kac_oauth','',0);
      if(!tx||!url.searchParams.get('state')||url.searchParams.get('state')!==tx.state||!url.searchParams.get('code'))throw err('فشل تأكيد تسجيل الدخول. تأكد من رابط العودة وصلاحيات التطبيق.',400);
      const p=new URLSearchParams({grant_type:'authorization_code',client_id:process.env.KICK_CLIENT_ID,client_secret:process.env.KICK_CLIENT_SECRET,redirect_uri:tx.callback,code_verifier:tx.verifier,code:url.searchParams.get('code')});
      const d=await outbound(AUTH+'/oauth/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:p.toString()});
      if(!d.access_token)throw err('لم يرجع Kick بيانات الوصول',502);
      const u=await kickGet('/public/v1/users',d.access_token);const user=Array.isArray(u.data)?u.data[0]:u.data||{};
      if(!user.user_id&&!user.id)throw err('لم نتمكن من تحديد مستخدم Kick',502);
      const id=String(user.user_id||user.id),a={id,username:user.name||user.username||user.slug||id,avatar:user.profile_picture||user.profile_pic||'',access_token:d.access_token,refresh_token:d.refresh_token||'',expires:Date.now()+Number(d.expires_in||3600)*1000,scope:d.scope||SCOPE};
      s.accounts=s.accounts.filter(x=>x.id!==id);s.accounts.push(a);await saveSession(res,s);
      res.statusCode=302;res.setHeader('Location','/?connected=1');return res.end();
    }
    if(action==='me'){
      if(req.method!=='GET')throw err('غير مسموح',405);
      if(s.accounts?.length){let changed=false;for(const a of s.accounts){if(a.refresh_token&&a.expires<Date.now()+15*60*1000){try{await accountToken(s,a.id);changed=true}catch(e){a.lastRefreshError=e.message}}}if(changed)await saveSession(res,s);if(backgroundEnabled()&&s._sid){try{await workerControl(s._sid,'session_refresh',true,Date.now()+1800000)}catch(e){/* renewal on next authenticated call remains available */}}}
      return json(res,200,{ok:true,accounts:publicAccounts(s),csrf:s.csrf,chatStorage:redisEnabled(),background:backgroundEnabled()});
    }

    if(action==='import_token'){
      if(req.method!=='POST')throw err('method',405);requireCsrf(req,s);const b=await readBody(req);
      const a=await verifyUserAccess(String(b.access_token||''));a.refresh_token=typeof b.refresh_token==='string'?b.refresh_token.trim().slice(0,2500):'';
      s.accounts=s.accounts.filter(x=>x.id!==a.id);s.accounts.push(a);await saveSession(res,s);
      return json(res,200,{ok:true,account:publicAccounts({accounts:[a]})[0]});
    }
    if(action==='refresh_accounts'){
      if(req.method!=='POST')throw err('method',405);requireCsrf(req,s);const statuses=[];
      for(const a of s.accounts||[]){try{if(a.refresh_token&&a.expires<Date.now()+20*60*1000)await accountToken(s,a.id);statuses.push({id:a.id,ok:a.expires>Date.now(),renewable:!!a.refresh_token})}catch(e){statuses.push({id:a.id,ok:false,error:e.message})}}
      await saveSession(res,s);return json(res,200,{ok:true,statuses,accounts:publicAccounts(s)});
    }
    if(action==='backup_export'){
      if(req.method!=='POST')throw err('method',405);requireCsrf(req,s);const b=await readBody(req);
      if(!b.local||typeof b.local!=='object'||Array.isArray(b.local))throw err('بيانات النسخة غير صحيحة');
      const text=encryptBackup({format:'KAC-SECURE-V4',createdAt:new Date().toISOString(),accounts:s.accounts||[],local:b.local},b.passphrase);
      return json(res,200,{ok:true,code:text});
    }
    if(action==='backup_import'){
      if(req.method!=='POST')throw err('method',405);requireCsrf(req,s);const b=await readBody(req),v=decryptBackup(b.code,b.passphrase);
      if(v.accounts.length>30)throw err('عدد الحسابات أكبر من الحد المسموح');
      const verified=[],warnings=[];
      for(const a of v.accounts){try{
        let token=String(a.access_token||'');let detail;
        try{detail=await verifyUserAccess(token)}catch(e){
          if(!a.refresh_token)throw e;
          const q=new URLSearchParams({grant_type:'refresh_token',client_id:process.env.KICK_CLIENT_ID,client_secret:process.env.KICK_CLIENT_SECRET,refresh_token:a.refresh_token});
          const renewed=await outbound(AUTH+'/oauth/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:q.toString()});token=renewed.access_token;detail=await verifyUserAccess(token);a.refresh_token=renewed.refresh_token||a.refresh_token;
        }
        if(detail.id!==String(a.id))throw err('هوية الحساب لا تطابق النسخة');
        detail.refresh_token=String(a.refresh_token||'');verified.push(detail);
      }catch(e){warnings.push({id:String(a.id||'unknown').slice(0,24),reason:e.message})}}
      // A restore must never inherit old still-running server jobs.
      if(s._sid && backgroundEnabled()){
        const ids=await redis('SMEMBERS','kac:jobs:'+s._sid)||[];
        for(const id of ids.slice(0,500)){
          const old=await loadPersistedJob(s._sid,id);
          if(old && ['running','pending'].includes(old.status)){
            old.status='paused';old.nextAt=null;await persistJob(s._sid,old);
            try{await workerControl(s._sid,id,false)}catch(e){warnings.push({id,reason:'تعذّر إيقاف جدول قديم على المشغل: '+e.message})}
          }
        }
      }
      s.accounts=verified;s.csrf=rand(24);await saveSession(res,s);
      return json(res,200,{ok:true,accounts:publicAccounts(s),csrf:s.csrf,local:v.local,warnings});
    }
    if(action==='jobs'){
      if(req.method!=='GET')throw err('method',405);if(!redisEnabled()||!s._sid)return json(res,200,{ok:true,jobs:[],background:false});
      const ids=await redis('SMEMBERS','kac:jobs:'+s._sid),jobs=[];
      for(const id of (ids||[]).slice(0,500)){const j=await loadPersistedJob(s._sid,id);if(j)jobs.push(j)}
      return json(res,200,{ok:true,jobs,background:backgroundEnabled()});
    }
    if(action==='job_command'){
      if(req.method!=='POST')throw err('method',405);requireCsrf(req,s);if(!backgroundEnabled()||!s._sid)throw err('مشغل الخلفية غير مفعّل، راجع Redis وCloudflare',503);
      const b=await readBody(req),command=String(b.command||''),id=String(b.job?.id||b.id||'');if(!validId(id))throw err('معرّف جدول غير صالح');
      let j=await loadPersistedJob(s._sid,id);
      if(command==='create'){
        if(j)throw err('الجدول محفوظ بالفعل؛ استخدم أوامر التشغيل أو الإيقاف',409);
        j=validateJob(b.job);if(!(s.accounts||[]).some(a=>String(a.id)===j.account))throw err('الحساب غير متصل',401);
        if(b.job.status==='running'){j.status='running';j.nextAt=Date.now()+1500;j.startedAt=Date.now()}
        else if(b.job.status==='pending'&&Number.isFinite(b.job.startAt)){j.status='pending';j.nextAt=Number(b.job.startAt)}
      }else if(!j)throw err('الجدول غير موجود على الخادم',404);
      else if(command==='delete'){
        await workerControl(s._sid,id,false);await redis('DEL',jobKey(s._sid,id));await redis('SREM','kac:jobs:'+s._sid,id);
        return json(res,200,{ok:true,deleted:true});
      }else if(['pause','stop'].includes(command)){j.status=command==='pause'?'paused':'stopped';j.nextAt=null;j.parentPaused=b.job?.parentPaused===true}
      else if(command==='options'){j.sendOffline=b.job?.sendOffline===true;if(j.status==='running')j.nextAt=Date.now()+1500}
      else if(command==='start'){
        if(j.inflight)throw err('هناك طلب سابق قيد المعالجة؛ راجع حالته قبل البدء',409);
        if(j.count!==null&&j.attempted>=j.count)throw err('الجدول انتهى عدد رسائله',409);
        if(j.endAt&&j.endAt<=Date.now())throw err('انتهى الوقت المحدد للجدول',409);
        j.status='running';j.nextAt=Date.now()+1500;j.startedAt ||= Date.now();j.parentPaused=false;
      }else throw err('الأمر غير مدعوم');
      await persistJob(s._sid,j);
      try{await workerControl(s._sid,id,['running','pending'].includes(j.status),j.nextAt)}catch(e){j.status='paused';j.lastError='تعذّر تسجيل مشغل الخلفية: '+e.message;await persistJob(s._sid,j);throw e}
      return json(res,200,{ok:true,job:j});
    }
    if(action==='channel'){
      if(req.method!=='GET')throw err('غير مسموح',405);
      const slug=normalizeSlug(url.searchParams.get('slug'));if(!slug)throw err('اسم القناة غير صحيح');
      const token=await appToken(),r=await kickGet('/public/v1/channels?slug='+encodeURIComponent(slug),token);
      const list=Array.isArray(r.data)?r.data:[];if(!list.length)throw err('القناة غير موجودة',404);
      const c=list[0];const st=c.stream||{};const clean={slug:c.slug,broadcaster_user_id:c.broadcaster_user_id,channel_description:c.channel_description||'',stream_title:c.stream_title||'',category:c.category||null,banner_picture:c.banner_picture||'',stream:{is_live:st.is_live===true,thumbnail:st.thumbnail||'',viewer_count:Number.isFinite(st.viewer_count)?st.viewer_count:null,start_time:st.start_time||null,language:st.language||''}};return json(res,200,{ok:true,channel:clean,retrievedAt:new Date().toISOString()});
    }
    if(action==='remove'){
      if(req.method!=='POST')throw err('غير مسموح',405);requireCsrf(req,s);
      const b=await readBody(req),account=String(b.account||'');
      if(s._sid && backgroundEnabled()){
        for(const id of (await redis('SMEMBERS','kac:jobs:'+s._sid)||[]).slice(0,500)){
          const j=await loadPersistedJob(s._sid,id);
          if(j&&j.account===account&&['running','pending'].includes(j.status)){
            j.status='paused';j.nextAt=null;await persistJob(s._sid,j);await workerControl(s._sid,id,false);
          }
        }
      }
      s.accounts=s.accounts.filter(x=>x.id!==account);await saveSession(res,s);return json(res,200,{ok:true,accounts:publicAccounts(s)});
    }
    if(action==='send'){
      if(req.method!=='POST')throw err('غير مسموح',405);requireCsrf(req,s);
      const b=await readBody(req),content=String(b.content||'').trim(),account=String(b.account||''),slug=normalizeSlug(b.slug);
      if(!slug)throw err('حدد قناة صحيحة');if(!content)throw err('اكتب الرسالة أولًا');
      const graphemes=typeof Intl.Segmenter==='function'?[...new Intl.Segmenter('ar',{granularity:'grapheme'}).segment(content)].length:[...content].length;
      if(graphemes>500||Buffer.byteLength(content,'utf8')>2048)throw err('تجاوزت الرسالة حد Kick: 500 حرف أو 2048 بايت');
      const a=await accountToken(s,account);if(!String(a.scope||'').split(/\s+/).includes('chat:write'))throw err('حسابك لم يمنح صلاحية chat:write',403);
      const ch=await kickGet('/public/v1/channels?slug='+encodeURIComponent(slug),await appToken());const item=ch.data?.[0];const broadcaster=Number(item?.broadcaster_user_id);
      if(!Number.isSafeInteger(broadcaster)||broadcaster<=0)throw err('لم يرجع Kick معرّف القناة الصحيح',502);
      const reply=String(b.reply_to_message_id||'');if(reply&&!/^[0-9a-fA-F-]{32,36}$/.test(reply))throw err('معرّف الرد غير صحيح');
      const lockKey=account+':'+broadcaster;
      if(redisEnabled()){
        const k='kac:sendlock:'+lockKey;
        if(await redis('SET',k,'1','EX',3,'NX')!=='OK')throw err('الإرسال متقارب جدًا. حاول بعد ثوانٍ.',429);
      }else{
        if((localSendCooldown.get(lockKey)||0)>Date.now())throw err('الإرسال متقارب جدًا. حاول بعد ثوانٍ.',429);
        localSendCooldown.set(lockKey,Date.now()+3000);
        if(localSendCooldown.size>1000)localSendCooldown.clear();
      }
      // Do not automatically retry ambiguous sends. A successful Kick response is returned, but webhook confirmation is distinct.
      const payload={type:'user',broadcaster_user_id:broadcaster,content};if(reply)payload.reply_to_message_id=reply;
      let r;try{r=await kickPost('/public/v1/chat',a.access_token,payload)}finally{await saveSession(res,s)}
      return json(res,200,{ok:true,accepted:r.data?.is_sent===true,confirmedByEvent:false,result:r.data||null});
    }
    if(action==='myrewards'){
      if(req.method!=='GET')throw err('غير مسموح',405);
      const a=await accountToken(s,url.searchParams.get('account'));if(!String(a.scope||'').split(/\s+/).includes('channel:rewards:read'))throw err('تحتاج صلاحية channel:rewards:read',403);
      const r=await kickGet('/public/v1/channels/rewards',a.access_token);await saveSession(res,s);
      return json(res,200,{ok:true,rewards:r.data||[]});
    }
    if(action==='subscribe'){
      if(req.method!=='POST')throw err('غير مسموح',405);requireCsrf(req,s);
      if(!s.accounts.length)throw err('سجّل دخولك أولًا',401);
      if(!redisEnabled())throw err('إعداد Redis مطلوب لاستقبال الشات',503);
      const b=await readBody(req),slug=normalizeSlug(b.slug);if(!slug)throw err('اسم القناة غير صحيح');
      const t=await appToken(),ch=await kickGet('/public/v1/channels?slug='+encodeURIComponent(slug),t);
      const broadcaster=Number(ch.data?.[0]?.broadcaster_user_id);if(!broadcaster)throw err('القناة غير موجودة',404);
      const old=await kickGet('/public/v1/events/subscriptions?broadcaster_user_id='+broadcaster,t);
      const existing=Array.isArray(old.data)?old.data:[];
      const needed=['chat.message.sent','livestream.status.updated'].filter(n=>!existing.some(x=>x.event===n&&Number(x.version)===1));
      if(!needed.length)return json(res,200,{ok:true,already:true,subscriptions:existing});
      const x=await kickPost('/public/v1/events/subscriptions',t,{broadcaster_user_id:broadcaster,method:'webhook',events:needed.map(name=>({name,version:1}))});
      return json(res,200,{ok:true,subscriptions:x.data||[]});
    }
    if(action==='chat'){
      if(req.method!=='GET')throw err('غير مسموح',405);
      if(!s.accounts.length)throw err('سجّل دخولك لقراءة سجل الأحداث الملتقطة',401);
      const id=Number(url.searchParams.get('broadcaster'));if(!Number.isSafeInteger(id)||id<=0)throw err('معرّف القناة غير صحيح');
      const rows=await redis('LRANGE','kac:chat:'+id,0,149);const items=(rows||[]).map(x=>{try{return JSON.parse(x)}catch{return null}}).filter(Boolean).reverse();
      return json(res,200,{ok:true,items,source:'Kick signed webhooks; only captured events from subscription onward'});
    }
    throw err('المسار غير موجود',404);
  }catch(e){failure(res,e)}
};
