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
  const raw=await new Promise((resolve,reject)=>{let d='';req.on('data',c=>{d+=c;if(d.length>16000){reject(err('البيانات أكبر من المسموح',413));req.destroy()}});req.on('end',()=>resolve(d));req.on('error',reject)});
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
function saveSession(res,s){s.exp=Date.now()+30*86400000;const v=seal(s);
  if(v.length>3750)throw err('وصلت الجلسة للحد المناسب للكوكيز. دعم عدد أكبر من الحسابات يحتاج قاعدة بيانات للجلسات.',413);
  setCookie(res,'kac_session',v,30*86400)}
async function accountToken(s,account){const a=(s?.accounts||[]).find(x=>String(x.id)===String(account));if(!a)throw err('اختار حساب متصل أولاً',401);
  if(a.expires>Date.now()+60000)return a;
  if(!a.refresh_token)throw err('جلسة Kick انتهت؛ سجّل دخولك تاني',401);
  const b=new URLSearchParams({grant_type:'refresh_token',client_id:process.env.KICK_CLIENT_ID,client_secret:process.env.KICK_CLIENT_SECRET,refresh_token:a.refresh_token});
  const d=await outbound(AUTH+'/oauth/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:b.toString()});
  if(!d.access_token)throw err('فشل تجديد صلاحية الحساب',401);
  a.access_token=d.access_token;a.refresh_token=d.refresh_token||a.refresh_token;a.expires=Date.now()+Number(d.expires_in||3600)*1000;a.scope=d.scope||a.scope;return a;
}
function publicAccounts(s){return (s.accounts||[]).map(a=>({id:a.id,username:a.username,avatar:a.avatar||'',expires:a.expires,scope:a.scope}));}
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
    const msg={id:String(b.message_id||id),kind:typ,timestamp:b.created_at||ts,sender:b.sender||{},content:String(b.content||''),replies_to:b.replies_to||null,stream:b.is_live===true?true:b.is_live===false?false:null,title:String(b.title||'')};
    const lua="if redis.call('SET',KEYS[1],'1','EX',86400,'NX') then redis.call('LPUSH',KEYS[2],ARGV[1]); redis.call('LTRIM',KEYS[2],0,349); redis.call('EXPIRE',KEYS[2],172800); return 1 else return 0 end";
    const inserted=await redis('EVAL',lua,2,'kac:event:'+id,'kac:chat:'+broadcaster,JSON.stringify(msg));
    return json(res,200,{ok:true,duplicate:inserted===0});
  }
  return json(res,200,{ok:true,ignored:true});
}
module.exports=async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('X-Frame-Options','DENY');res.setHeader('Cache-Control','no-store');
  try{
    const url=new URL(req.url,'https://'+(req.headers.host||'localhost'));
    const action=url.searchParams.get('action')||'health';
    if(action==='webhook')return await handleWebhook(req,res);
    if(!['GET','POST'].includes(req.method))throw err('غير مسموح',405);
    if(action==='health')return json(res,200,{ok:true,configured:!!(process.env.KICK_CLIENT_ID&&process.env.KICK_CLIENT_SECRET&&process.env.SESSION_SECRET),chatStorage:redisEnabled(),version:'2026.10'});
    let s=unseal(cookie(req,'kac_session'))||{accounts:[],csrf:rand(24)};
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
      s.accounts=s.accounts.filter(x=>x.id!==id);s.accounts.push(a);saveSession(res,s);
      res.statusCode=302;res.setHeader('Location','/?connected=1');return res.end();
    }
    if(action==='me'){
      if(req.method!=='GET')throw err('غير مسموح',405);
      return json(res,200,{ok:true,accounts:publicAccounts(s),csrf:s.csrf,chatStorage:redisEnabled()});
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
      const b=await readBody(req);s.accounts=s.accounts.filter(x=>x.id!==String(b.account||''));saveSession(res,s);return json(res,200,{ok:true,accounts:publicAccounts(s)});
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
        if(await redis('SET',k,'1','EX',8,'NX')!=='OK')throw err('الإرسال متقارب جدًا. حاول بعد ثوانٍ.',429);
      }else{
        if((localSendCooldown.get(lockKey)||0)>Date.now())throw err('الإرسال متقارب جدًا. حاول بعد ثوانٍ.',429);
        localSendCooldown.set(lockKey,Date.now()+8000);
        if(localSendCooldown.size>1000)localSendCooldown.clear();
      }
      // Do not automatically retry ambiguous sends. A successful Kick response is returned, but webhook confirmation is distinct.
      const payload={type:'user',broadcaster_user_id:broadcaster,content};if(reply)payload.reply_to_message_id=reply;
      let r;try{r=await kickPost('/public/v1/chat',a.access_token,payload)}finally{saveSession(res,s)}
      return json(res,200,{ok:true,accepted:r.data?.is_sent===true,confirmedByEvent:false,result:r.data||null});
    }
    if(action==='myrewards'){
      if(req.method!=='GET')throw err('غير مسموح',405);
      const a=await accountToken(s,url.searchParams.get('account'));if(!String(a.scope||'').split(/\s+/).includes('channel:rewards:read'))throw err('تحتاج صلاحية channel:rewards:read',403);
      const r=await kickGet('/public/v1/channels/rewards',a.access_token);saveSession(res,s);
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
