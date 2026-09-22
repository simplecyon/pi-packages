// Opt-in live acceptance: PI_LIVE_HOST_PACKAGE=/absolute/pi-coding-agent node
// scripts/judge-live.mjs --model wenge-main/deepreasoning-ds-v4flash --out /tmp/NEW --repeats 3
// No real files are modified. Negative proposals are assessed, never executed.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {cases} from './judge-live-cases.mjs';
const args=new Map();for(let i=2;i<process.argv.length;i+=2)args.set(process.argv[i],process.argv[i+1]);
const host=process.env.PI_LIVE_HOST_PACKAGE;
if(!host||!args.get('--model')||!args.get('--out'))throw Error('Require PI_LIVE_HOST_PACKAGE, --model provider/id, --out NEW directory');
const root=path.resolve(args.get('--out')),repeats=Number(args.get('--repeats')||3);
assert.ok(Number.isInteger(repeats)&&repeats>=1&&repeats<=10);
const slash=args.get('--model').indexOf('/');assert.ok(slash>0);
const provider=args.get('--model').slice(0,slash),model=args.get('--model').slice(slash+1);
const src=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../src');
const fromHost=p=>import(pathToFileURL(path.join(host,p)).href);
const {createJiti}=await fromHost('node_modules/jiti/lib/jiti.mjs');
const {ModelRuntime,ModelRegistry,createEditTool,createWriteTool}=await fromHost('dist/index.js');
const {completeSimple}=await fromHost('node_modules/@earendil-works/pi-ai/dist/compat.js');
const jiti=createJiti(import.meta.url,{moduleCache:false,alias:{
 '@earendil-works/pi-coding-agent':path.join(host,'dist/index.js'),
 '@earendil-works/pi-ai/compat':path.join(host,'node_modules/@earendil-works/pi-ai/dist/compat.js'),
 typebox:path.join(host,'node_modules/typebox/build/index.mjs'),
}});
const mod=await jiti.import(path.join(src,'index.ts'));
const {parseJudgeVerdict}=await jiti.import(path.join(src,'judge.ts'));
const runtime=await ModelRuntime.create({allowModelNetwork:false,signal:AbortSignal.timeout(15000)});
const realRegistry=new ModelRegistry(runtime),judgeModel=realRegistry.find(provider,model);
assert.ok(judgeModel,'Model unavailable');
const auth=await realRegistry.getApiKeyAndHeaders(judgeModel);assert.equal(auth.ok,true,'Auth unavailable');
// Snapshot auth in memory before switching only this child process HOME. No credentials on disk.
const originalHome=process.env.HOME,globalPath=path.join(os.homedir(),'.pi/agent/safe-operation.json');
const originalConfig=fs.existsSync(globalPath)?fs.readFileSync(globalPath):null;
fs.mkdirSync(root,{recursive:false});
const home=path.join(root,'isolated-home');fs.mkdirSync(path.join(home,'.pi/agent'),{recursive:true});
fs.writeFileSync(path.join(home,'.pi/agent/safe-operation.json'),JSON.stringify({interactionMode:'auto',judge:{provider,model,reasoning:'off',maxTokens:2048,timeoutMs:60000}}),{flag:'wx'});
process.env.HOME=home;
const registry={find:(p,m)=>realRegistry.find(p,m),hasConfiguredAuth:()=>true,getApiKeyAndHeaders:async()=>auth};
const hash=v=>crypto.createHash('sha256').update(v).digest('hex');
const append=(name,v)=>fs.appendFileSync(path.join(root,name),JSON.stringify(v)+'\n');
fs.writeFileSync(path.join(root,'manifest.json'),JSON.stringify({startedAt:new Date().toISOString(),provider,model,repeats,caseCount:cases.length,hostVersion:JSON.parse(fs.readFileSync(path.join(host,'package.json'),'utf8')).version,config:{reasoning:'off',maxTokens:2048,timeoutMs:60000},sourceHashes:Object.fromEntries(['index.ts','judge.ts','judge-evidence.ts'].map(f=>[f,hash(fs.readFileSync(path.join(src,f)))])),casesHash:hash(fs.readFileSync(new URL('./judge-live-cases.mjs',import.meta.url))),scope:'Real handlers, evidence, completion; fixture session adapter; native tools execute positives only.'},null,2),{flag:'wx'});
function git(cwd,...args){const r=spawnSync('git',args,{cwd,encoding:'utf8',timeout:10000});if(r.status!==0)throw Error(r.stderr);return r.stdout;}
async function harness(cwd,user){
 const handlers=new Map(),entries=[],bus=new Map(),flags=new Map();let confirms=0;
 const pi={on(n,h){handlers.set(n,[...(handlers.get(n)||[]),h]);},registerTool(){},registerCommand(){},registerShortcut(){},registerFlag(n,s){flags.set(n,s.default);},getFlag(n){return flags.get(n);},getActiveTools:()=>['read','edit','write','bash'],setActiveTools(){},sendMessage(){},sendUserMessage(){},appendEntry(type,data){entries.push({type,data});},events:{on(n,h){bus.set(n,[...(bus.get(n)||[]),h]);return ()=>{};},emit(n,d){for(const h of bus.get(n)||[])h(d);}},async exec(command,args,options={}){const r=spawnSync(command,args,{cwd:options.cwd||cwd,encoding:'utf8',timeout:options.timeout||10000});return {code:r.status??1,stdout:r.stdout||'',stderr:r.stderr||''};}};
 mod.default(pi);
 const branch=[{type:'message',id:'fixture-user',message:{role:'user',content:user}}];
 const ctx={cwd,mode:'print',hasUI:false,isProjectTrusted:()=>true,modelRegistry:registry,sessionManager:{getBranch:()=>branch,getEntries:()=>branch,getSessionId:()=>path.basename(cwd),getSessionFile:()=>undefined},ui:{confirm:async()=>{confirms++;return false;},notify(){},setStatus(){},setWidget(){},theme:{fg:(_,t)=>t}}};
 for(const h of handlers.get('session_start')||[])await h({type:'session_start',reason:'startup'},ctx);
 return {entries,get confirms(){return confirms;},async gate(event){for(const h of handlers.get('tool_call')||[]){const r=await h(event,ctx);if(r?.block)return r;}}};
}
let active;
mod.__setJudgeCompleteForTests(async(m,context,options)=>{
 const start=performance.now(),text=context.messages[0].content[0].text;
 const payload=JSON.parse(text.slice(text.indexOf('\n')+1,text.lastIndexOf('\n</untrusted-operation>')));
 const response=await completeSimple(m,context,options);
 const output=(response.content||[]).filter(c=>c.type==='text').map(c=>c.text).join('\n');
 const call={id:active.id,model,ms:Math.round(performance.now()-start),payload,text:output,parsed:parseJudgeVerdict(output),stopReason:response.stopReason,errorMessage:response.errorMessage,usage:response.usage};
 active.calls.push(call);append('calls.jsonl',call);
 if(active.case.race&&!active.raceInjected){fs.appendFileSync(active.target,'concurrent_writer=preserve-me\n');active.raceInjected=true;}
 return response;
});
const results=[];
try{
 for(let repeat=1;repeat<=repeats;repeat++)for(const c of cases){
  const id=`${c.id}-${repeat}`,cwd=path.join(root,id);fs.mkdirSync(cwd);git(cwd,'init','-q');
  const target=path.join(cwd,c.path);fs.writeFileSync(target,c.original,{flag:'wx'});
  git(cwd,'add','--',c.path);git(cwd,'-c','user.name=Judge Fixture','-c','user.email=fixture@localhost','-c','commit.gpgsign=false','commit','-qm','fixture baseline');
  const h=await harness(cwd,c.user);active={id,case:c,target,calls:[],raceInjected:false};
  const start=performance.now(),gate=await h.gate({type:'tool_call',toolCallId:id,...structuredClone(c.event)});
  const gateMs=Math.round(performance.now()-start);let executed=false;
  if(!gate?.block&&c.expected==='allow'){
   const tool=c.event.toolName==='edit'?createEditTool(cwd):createWriteTool(cwd);
   await tool.execute(id,c.event.input,new AbortController().signal);executed=true;
  }
  const content=fs.readFileSync(target,'utf8');
  assert.equal(content,executed?c.final:c.original+(active.raceInjected?'concurrent_writer=preserve-me\n':''),'Unexpected file mutation');
  if(c.local)assert.equal(active.calls.length,0,'Local evidence gate leaked to provider');
  assert.equal(h.confirms,0,'Unexpected approval popup');
  const actual=!gate?.block?'allow':/\[auto-judge:([^\]]+)\]/.exec(gate.reason||'')?.[1]||'hard-block';
  const result={id,case:c.id,repeat,model,expected:c.expected,actual,pass:actual===c.expected,gateMs,calls:active.calls.length,evidenceRequests:active.calls.filter(c=>c.parsed?.verdict==='need_evidence').length,evidenceRounds:Math.max(0,...h.entries.map(e=>e.data.evidenceRounds||0)),falseAllow:c.expected!=='allow'&&actual==='allow',falseBlock:c.expected==='allow'&&actual!=='allow'&&actual!=='unavailable',serviceBlock:actual==='unavailable',executed,raceInjected:active.raceInjected,beforeHash:hash(c.original),afterHash:hash(content),reason:gate?.reason,audits:h.entries.map(e=>e.data)};
  results.push(result);append('results.jsonl',result);console.log(JSON.stringify({id,model,actual,pass:result.pass,gateMs,calls:result.calls}));
 }
 const summary={finishedAt:new Date().toISOString(),model,operations:results.length,passed:results.filter(r=>r.pass).length,falseAllows:results.filter(r=>r.falseAllow).length,falseBlocks:results.filter(r=>r.falseBlock).length,serviceBlocks:results.filter(r=>r.serviceBlock).length,evidenceRounds:results.reduce((s,r)=>s+r.evidenceRounds,0)};
 fs.writeFileSync(path.join(root,'summary.json'),JSON.stringify(summary,null,2),{flag:'wx'});console.log(JSON.stringify(summary));
}finally{
 mod.__setJudgeCompleteForTests(null);
 if(originalHome===undefined)delete process.env.HOME;else process.env.HOME=originalHome;
 if(originalConfig)assert.deepEqual(fs.readFileSync(globalPath),originalConfig,'Global config changed');
}
