'use strict';
/* Offline scheduler unit tests. No Kick traffic or fake data in the shipped app. */
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),crypto=require('node:crypto');
const code=fs.readFileSync(__dirname+'/script.js','utf8');
const fragment=code.slice(code.indexOf('// Per-account, per-channel, per-schedule model'),code.indexOf('function stopPlayer(){'));
const context={crypto:crypto.webcrypto,TextEncoder,Option:class{},Date,Intl,console,document:{hidden:false},navigator:{onLine:true},Math};
vm.createContext(context);
const prelude=`const data={jobs:[],accountConfigs:{},prefs:{lang:'ar'}}; const api={accounts:[{id:'5',username:'user5'}],csrf:'x'};
const slug=s=>/^[a-z0-9_-]{1,25}$/.test(s)?s:'';
const txt=s=>s;
const $=id=>({value:'',checked:false,replaceChildren(){},add(){}});
const node=(type,cls,content)=>({type,cls,content,append(){}});
const saveLocal=async()=>{};const toast=()=>{};const jobRequest=null;
${fragment}
globalThis.testing={cleanAccountConfigs,cleanImportedJobs,accountState,streamLinks,pairEnabled,nextDelay,data,api};`;
vm.runInContext(prelude,context);
const t=context.testing;
const clean=t.cleanAccountConfigs({'5':{enabled:false,channels:['real','bad/slug','real'],disabledStreams:['real'],profiles:{real:{messages:'Hello',randomDelay:true,delayMin:35,delayMax:55,count:4}}},'unsafe!':{enabled:true}});
assert.deepEqual(JSON.parse(JSON.stringify(clean['5'].channels)),['real']);assert.equal(clean['5'].profiles.real.randomDelay,true);assert.equal(clean['5'].enabled,false);assert.equal(clean['unsafe!'],undefined);
t.data.accountConfigs=clean;assert.equal(t.pairEnabled('5','real'),false);t.accountState('5').enabled=true;assert.equal(t.pairEnabled('5','real'),false);t.accountState('5').disabledStreams=[];assert.equal(t.pairEnabled('5','real'),true);
assert.deepEqual(JSON.parse(JSON.stringify(t.streamLinks('5'))),['real']);
const jobs=t.cleanImportedJobs([{id:'j1',account:'5',slug:'real',name:'one',messages:['hello'],status:'running',sent:2,index:3,attempted:3,intervalMs:60000,randomDelay:true,delayMinMs:40000,delayMaxMs:90000,count:5}]);
assert.equal(jobs.length,1);assert.equal(jobs[0].status,'paused');assert.equal(jobs[0].index,3);assert.equal(jobs[0].attempted,3);
assert.equal(t.nextDelay({randomDelay:false,intervalMs:61000}),61000);
for(let k=0;k<500;k++){const delay=t.nextDelay({randomDelay:true,delayMinMs:40000,delayMaxMs:41000});assert.ok(delay>=40000&&delay<=41000)}
console.log('PASS: 5 scheduler checks — per-account config, per-stream stop, safe import, fixed/random delay');
