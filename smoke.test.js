'use strict';
/* Offline transport tests for the actual handler. Fixtures are NOT shipped in the public app. */
const assert=require('node:assert/strict');
const {Readable}=require('node:stream');
const crypto=require('node:crypto');
const handler=require('./api/index.js');
process.env.SESSION_SECRET='unit_test_only_session_secret_abcdefghijklmnopqrstuvwxyz0123456789';
process.env.KICK_CLIENT_ID='dummy-client-id';process.env.KICK_CLIENT_SECRET='dummy-client-secret';
process.env.KICK_REDIRECT_URI='https://example.test/api?action=callback';
let posts=[],replyBody;
const kp=crypto.generateKeyPairSync('rsa',{modulusLength:2048});
const pem=kp.publicKey.export({type:'spki',format:'pem'});
const storedEvents=new Map(),eventIds=new Set(),sessionDB=new Map();let oauthUserId=124;
const fakeFetch=async(url,options={})=>{
  posts.push({url:String(url),options});
  if(String(url).includes('redis.test')){
    const args=JSON.parse(options.body||'[]');let result=null;
    if(args[0]==='EVAL'){const id=args[3],channel=args[4],payload=args[5];if(eventIds.has(id))result=0;else{eventIds.add(id);storedEvents.set(channel,[payload,...(storedEvents.get(channel)||[])].slice(0,350));result=1}}
    if(args[0]==='LRANGE')result=(storedEvents.get(args[1])||[]).slice(0,150);
    if(args[0]==='SET'){sessionDB.set(args[1],args[2]);result='OK'}
    if(args[0]==='GET')result=sessionDB.get(args[1])||null;
    return {ok:true,status:200,text:async()=>JSON.stringify({result})};
  }
  const data=String(url).includes('/public/v1/public-key')?{data:{public_key:pem}}:String(url).includes('/oauth/token')?{access_token:'FAKE_USER_ACCESS_TOKEN',refresh_token:'FAKE_REFRESH_TOKEN',expires_in:3600,scope:'user:read channel:read chat:write channel:rewards:read'}:
    String(url).includes('/public/v1/users')?{data:[{name:'example-user-'+oauthUserId,user_id:oauthUserId,profile_picture:'https://kick.com/example.png',email:'not-exposed@example.com'}]}:
    String(url).includes('/public/v1/channels?')?{data:[{slug:'good-channel',broadcaster_user_id:42,stream_title:'A title',channel_description:'Description',stream:{is_live:true,viewer_count:77,thumbnail:'https://kick.com/image.jpg',key:'NEVER_RETURN_STREAMKEY',url:'rtmps://private.url'}}]}:
    String(url).includes('/public/v1/chat')? (replyBody={is_sent:true,message_id:'828f83bb-e391-4c78-9e91-af35a172840e'}, {data:replyBody}):
    String(url).includes('/public/v1/channels/rewards')?{data:[{id:'r1',title:'Test',cost:40}]}:{message:'OK',data:{}};
  return {ok:true,status:200,text:async()=>JSON.stringify(data)};
};
global.fetch=fakeFetch;
async function run(method,url,{cookie='',headers={},body}={}){
  const payload=body===undefined?'':typeof body==='string'?body:JSON.stringify(body);
  const req=Readable.from([payload]);req.method=method;req.url=url;req.headers={host:'example.test',cookie,...headers};
  if(payload){req.headers['content-type']='application/json'}
  const h={};let text='';const res={statusCode:200,setHeader(k,v){h[k]=v},getHeader(k){return h[k]},end(v=''){text+=String(v)}};
  await handler(req,res);let parsed=null;try{parsed=JSON.parse(text)}catch{}
  return {status:res.statusCode,data:parsed,headers:h,raw:text};
}
function valuesSetCookies(r){return (r.headers['Set-Cookie']||[]).map(x=>x.split(';')[0]).join('; ')}
async function main(){
 let r=await run('GET','/api?action=health');assert.equal(r.status,200);assert.equal(r.data.configured,true);
 r=await run('GET','/api?action=channel&slug=good-channel');assert.equal(r.status,200);assert.equal(r.data.channel.broadcaster_user_id,42);assert.equal(r.data.channel.stream.is_live,true);assert.equal('key' in r.data.channel.stream,false);assert.equal('url' in r.data.channel.stream,false);
 r=await run('GET','/api?action=channel&slug=wrong%20name');assert.equal(r.status,400);
 r=await run('GET','/api?action=auth');assert.equal(r.status,302);assert.ok(r.headers.Location.startsWith('https://id.kick.com/oauth/authorize?'));
 const url=new URL(r.headers.Location);assert.equal(url.searchParams.get('code_challenge_method'),'S256');assert.equal(url.searchParams.get('redirect_uri'),process.env.KICK_REDIRECT_URI);
 let oauthCookie=valuesSetCookies(r);
 r=await run('GET','/api?action=callback&code=AUTH_CODE&state=WRONG',{cookie:oauthCookie});assert.equal(r.status,400);
 r=await run('GET','/api?action=auth');oauthCookie=valuesSetCookies(r);const state=new URL(r.headers.Location).searchParams.get('state');
 r=await run('GET','/api?action=callback&code=AUTH_CODE&state='+state,{cookie:oauthCookie});assert.equal(r.status,302);const session=valuesSetCookies(r);
 r=await run('GET','/api?action=me',{cookie:session});assert.equal(r.data.accounts.length,1);assert.equal(r.data.accounts[0].username,'example-user-124');assert.equal(JSON.stringify(r.data).includes('FAKE_USER_ACCESS_TOKEN'),false);assert.equal(JSON.stringify(r.data).includes('not-exposed'),false);
 const csrf=r.data.csrf;
 r=await run('POST','/api?action=send',{cookie:session,body:{account:'124',slug:'good-channel',content:'Hello'}});assert.equal(r.status,403);
 r=await run('POST','/api?action=send',{cookie:session,headers:{'x-kac-csrf':csrf,origin:'https://evil.test'},body:{account:'124',slug:'good-channel',content:'Hello'}});assert.equal(r.status,403);
 r=await run('POST','/api?action=send',{cookie:session,headers:{'x-kac-csrf':csrf,origin:'https://example.test'},body:{account:'124',slug:'good-channel',content:'Hello'}});assert.equal(r.status,200);assert.equal(r.data.accepted,true);assert.equal(r.data.confirmedByEvent,false);
 const sent=posts.findLast(x=>x.url.includes('/public/v1/chat'));assert.deepEqual(JSON.parse(sent.options.body),{type:'user',broadcaster_user_id:42,content:'Hello'});
 r=await run('POST','/api?action=send',{cookie:session,headers:{'x-kac-csrf':csrf},body:{account:'124',slug:'good-channel',content:'x'.repeat(501)}});assert.equal(r.status,400);
 r=await run('POST','/api?action=remove',{cookie:session,headers:{'x-kac-csrf':csrf},body:{account:'124'}});assert.equal(r.status,200);assert.equal(r.data.accounts.length,0);
 r=await run('GET','/api?action=chat&broadcaster=42',{cookie:session});assert.equal(r.status,503);
 const messageId='01SAMPLE_EVENT_ID_000000000001';const when=new Date().toISOString();
 const eventJson=JSON.stringify({message_id:'828f83bb-e391-4c78-9e91-af35a172840e',broadcaster:{user_id:42,username:'good-channel'},sender:{username:'alice'},content:'real-event-fixture'});
 const eventHeaders={'kick-event-message-id':messageId,'kick-event-message-timestamp':when,'kick-event-type':'chat.message.sent','kick-event-signature':crypto.sign('RSA-SHA256',Buffer.from(`${messageId}.${when}.${eventJson}`),kp.privateKey).toString('base64')};
 r=await run('POST','/api?action=webhook',{body:eventJson,headers:{...eventHeaders,'kick-event-signature':'invalid'}});assert.equal(r.status,401);
 r=await run('POST','/api?action=webhook',{body:eventJson,headers:eventHeaders});assert.equal(r.status,503);
 process.env.UPSTASH_REDIS_REST_URL='https://redis.test';process.env.UPSTASH_REDIS_REST_TOKEN='unit-test-only';
 r=await run('POST','/api?action=webhook',{body:eventJson,headers:eventHeaders});assert.equal(r.status,200);assert.equal(r.data.ok,true);
 r=await run('POST','/api?action=webhook',{body:eventJson,headers:eventHeaders});assert.equal(r.data.duplicate,true);
 r=await run('GET','/api?action=chat&broadcaster=42',{cookie:session});assert.equal(r.status,200);assert.equal(r.data.items.length,1);assert.equal(r.data.items[0].content,'real-event-fixture');
 // New Redis-backed encrypted sessions: 2 distinct real OAuth identities in one session,
 // stored server-side (not packed together into a browser cookie).
 const originalSessionCookie=session.split('; ').find(x=>x.startsWith('kac_session='));
 r=await run('GET','/api?action=auth',{cookie:originalSessionCookie});
 let cookie1=valuesSetCookies(r),state1=new URL(r.headers.Location).searchParams.get('state');
 r=await run('GET','/api?action=callback&code=AUTH_CODE&state='+state1,{cookie:originalSessionCookie+'; '+cookie1});
 assert.equal(r.status,302);const sidCookie=valuesSetCookies(r).split('; ').find(x=>x.startsWith('kac_sid='));assert.ok(sidCookie.includes('kac_sid='));assert.ok(!sidCookie.includes('FAKE_USER_ACCESS_TOKEN'));
 r=await run('GET','/api?action=me',{cookie:sidCookie});assert.equal(r.data.accounts.length,1);
 oauthUserId=125;
 r=await run('GET','/api?action=auth',{cookie:sidCookie});
 cookie1=valuesSetCookies(r);state1=new URL(r.headers.Location).searchParams.get('state');
 r=await run('GET','/api?action=callback&code=AUTH_CODE&state='+state1,{cookie:sidCookie+'; '+cookie1});
 assert.equal(r.status,302);
 r=await run('GET','/api?action=me',{cookie:sidCookie});
 assert.equal(r.data.accounts.length,2);assert.deepEqual(r.data.accounts.map(x=>x.id),['124','125']);
 console.log('PASS: multi-account Redis encrypted sessions +');
 console.log('PASS: health, sanitized Kick channels, OAuth+PKCE+state, encrypted session, CSRF, official user chat, limits, account removal, signed RSA webhook verification, deduplication and Redis event storage');
}
main().catch(e=>{console.error(e);process.exitCode=1});
