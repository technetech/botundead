import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Workspace } from '../src/workspace.js';
import { Agents } from '../src/agents.js';
import { ApiError } from '../src/api.js';
import { connectionUrl, publicAddress, connectionKey } from '../src/connections.js';
import { validateDecision } from '../src/prompt-bot.js';
import { createDashboard } from '../src/dashboard.js';

function config(a,extra={}) { return { name:a.name,prompt:a.prompt,mode:a.mode,enabled:a.enabled,engine:a.engine,entries:a.strategy.entries||a.strategy.symbols.map(symbol=>({symbol,margin:a.strategy.margin,leverage:a.strategy.leverage,direction:a.strategy.direction})),...extra }; }
const ai = {name:'NVIDIA',kind:'ai',url:'https://integrate.api.nvidia.com/v1',model:'nvidia/test-model',auth:'bearer',apiKey:'private-model-token'};
const source = {name:'Fuente',kind:'data',url:'https://data.example.com/prices',auth:'header',header:'X-API-Key',apiKey:'private-data-token'};
async function fixture(env={}) { const dir=fs.mkdtempSync(path.join(os.tmpdir(),'undeadbot-features-')); const workspace=await new Workspace({DATA_DIR:dir,...env}).init(); const agents=new Agents(workspace);return {dir,workspace,agents,close:async()=>{await workspace.close();fs.rmSync(dir,{recursive:true,force:true});}}; }

test('capital is persisted up to one million; invalid capitals and portfolios exceeding the budget are rejected',async()=>{
 const f=await fixture();try{
  const a=await f.agents.create({name:'Capital',initialCapital:1000000});assert.equal(a.initialCapital,1000000);
  for(const initialCapital of [0,-1,1000000.01,Infinity,'1000',0.001]) await assert.rejects(f.agents.create({initialCapital}),/capital/);
  const small=await f.agents.create({initialCapital:10});assert.ok(small.strategy.symbols.length*small.strategy.margin<=10);await assert.rejects(f.agents.update(small.id,config(small,{entries:[{symbol:'BTC',margin:11,leverage:1,direction:'long'}]})),/capital/);
  const restarted=await new Workspace({DATA_DIR:f.dir}).init();assert.equal((await new Agents(restarted).list()).agents.find(p=>p.id===a.id).initialCapital,1000000);await restarted.close();
 }finally{await f.close();}
});

test('saving the frontend configuration starts virtual trading automatically once wallet settings are complete',async()=>{
 const f=await fixture();try{
  let a=(await f.agents.list()).agents[0];assert.equal(a.enabled,false);assert.equal(a.mode,'dry-run');
  const input={name:a.name,prompt:a.prompt,engine:'bot',autoStart:true,entries:[{symbol:'BTC',margin:25,leverage:2,direction:'long'}]};
  a=await f.agents.update(a.id,input);assert.equal(a.enabled,false);assert.equal(a.mode,'live');assert.deepEqual(a.execution.missing,['Conecta la API de Undeadwallet']);
  a=await f.agents.update(a.id,{...input,apiKey:'wallet-key'});assert.equal(a.enabled,true);assert.equal(a.mode,'live');assert.equal(a.execution.ready,true);
  await f.workspace.run(data=>{data.agents[0].startedAt='2026-10-08T16:24:00Z';});
  const api=fakeApi();const agents=new Agents(f.workspace,()=>api,()=>new Date('2026-10-08T16:25:00Z'));await agents.tick();assert.equal(api.orders.length,1);
 }finally{await f.close();}
});

test('saving agent mode waits for the AI credentials and keeps error pauses after settings are complete',async()=>{
 const f=await fixture();try{
  let a=(await f.agents.list()).agents[0];const input={name:a.name,prompt:a.prompt,engine:'agent',autoStart:true,apiKey:'wallet-key'};
  a=await f.agents.update(a.id,input);assert.equal(a.enabled,false);assert.ok(a.execution.missing.includes('Añade un proveedor de IA'));
  a=await f.agents.update(a.id,{...input,connections:[ai,{...source,apiKey:''}]});assert.equal(a.enabled,false);assert.ok(a.execution.missing.some(message=>message.includes('Fuente')));
  a=await f.agents.update(a.id,{...input,connections:[ai,source]});assert.equal(a.enabled,true);assert.equal(a.mode,'live');
  await f.workspace.run(data=>{data.agents[0].state.paused='Revisar error anterior';});
  a=await f.agents.update(a.id,input);assert.equal(a.paused,'Revisar error anterior');
 }finally{await f.close();}
});

test('engine selection is exclusive and agent activation requires its model and a credential',async()=>{
 const f=await fixture();try{
  let a=(await f.agents.list()).agents[0];assert.equal(a.engine,'bot');
  await assert.rejects(f.agents.update(a.id,config(a,{engine:'both'})),/único modo/);
  await assert.rejects(f.agents.update(a.id,config(a,{apiKey:'wallet',engine:'agent',enabled:true})),/API de IA/);
  a=await f.agents.update(a.id,config(a,{apiKey:'wallet',engine:'agent',enabled:true,connections:[ai]}));assert.equal(a.engine,'agent');
  a=await f.agents.update(a.id,config(a,{engine:'bot'}));assert.equal(a.engine,'bot');assert.equal(a.connections.length,1);
  await f.workspace.run(data=>{data.agents[0].state.positions.push({id:1,symbol:'BTC',status:'open',day:'2026-10-08'});});
  await assert.rejects(f.agents.update(a.id,config(a,{engine:'agent'})),/pendientes/);
 }finally{await f.close();}
});

test('individual API connections are encrypted, retain credentials, remove independently and resolve NVIDIA environment defaults',async()=>{
 const f=await fixture();try{
  let a=(await f.agents.list()).agents[0];a=await f.agents.update(a.id,config(a,{connections:[ai,source]}));
  assert.equal(a.connections.length,2);assert.ok(!JSON.stringify(a).includes(ai.apiKey));assert.ok(!fs.readFileSync(f.workspace.file,'utf8').includes(source.apiKey));
  a=await f.agents.update(a.id,config(a,{connections:a.connections.map(c=>({...c,apiKey:''}))}));
  await f.workspace.run(data=>assert.equal(connectionKey(data.agents[0].connections[0],f.workspace),ai.apiKey));
  a=await f.agents.update(a.id,config(a,{connections:[a.connections[0]]}));assert.equal(a.connections.length,1);
  a=await f.agents.update(a.id,config(a,{connections:[]}));assert.equal(a.connections.length,0);
  f.workspace.env.NVIDIA_API_KEY='environment-private';f.workspace.env.NVIDIA_MODEL='nvidia/model';
  assert.equal((await f.agents.list()).agents[0].connections.length,0);
  a=await f.agents.create({name:'Environment defaults'});assert.equal(a.connections[0].source,'environment');assert.equal(a.connections[0].model,'nvidia/model');assert.ok(!JSON.stringify(a).includes('environment-private'));
  a=await f.agents.update(a.id,config(a,{connections:[]}));assert.equal(a.connections.length,0);
 }finally{await f.close();}
});

test('custom API configuration rejects unsafe URLs, forbidden headers and changing credential destination silently',async()=>{
 const f=await fixture();try{
  for(const url of ['http://api.example.com','https://127.0.0.1/','https://localhost/','https://user:pass@api.example.com','https://api.example.com/?api_key=secret'])assert.throws(()=>connectionUrl(url));
  for(const ip of ['127.0.0.1','10.2.3.4','169.254.169.254','192.168.1.1','172.16.0.1','::ffff:127.0.0.1'])assert.equal(publicAddress(ip),false);
  assert.equal(publicAddress('8.8.8.8'),true);
  let a=(await f.agents.list()).agents[0];await assert.rejects(f.agents.update(a.id,config(a,{connections:[{...source,header:'Host'}]})),/Encabezado/);
  await assert.rejects(f.agents.update(a.id,config(a,{connections:[{...source,envKey:'DASHBOARD_PASSWORD'}]})),/API_KEY/);
  a=await f.agents.update(a.id,config(a,{connections:[source]}));await assert.rejects(f.agents.update(a.id,config(a,{connections:[{...a.connections[0],url:'https://another.example.com',apiKey:''}]})),/dominio/);
 }finally{await f.close();}
});

test('deleting any idle space, including the last, archives history and releases its slot without reseeding on restart',async()=>{
 const f=await fixture();try{
  const first=(await f.agents.list()).agents[0];await f.agents.remove(first.id);assert.equal((await f.agents.list()).agents.length,0);
  const restarted=await new Workspace({DATA_DIR:f.dir}).init();assert.equal((await new Agents(restarted).list()).agents.length,0);await restarted.close();
  const next=await f.agents.create({name:'New'});assert.equal(next.slot,1);assert.notEqual(next.id,first.id);
  await f.workspace.run(data=>{assert.equal(data.archivedAgents[0].id,first.id);data.agents[0].state.days.cycle={BTC:{status:'pending'}};});
  await assert.rejects(f.agents.remove(next.id),/pendientes/);await assert.rejects(f.agents.remove(first.id),/encontrado/);
 }finally{await f.close();}
});

test('asset dropdown catalogue comes from authenticated Undeadwallet and caches only the matching agent credentials',async()=>{
 const f=await fixture();try{
  let a=(await f.agents.list()).agents[0];await assert.rejects(f.agents.assets(a.id),/Conecta/);
  a=await f.agents.update(a.id,config(a,{apiKey:'wallet-key'}));let reads=0;
  f.agents.apiFactory=key=>{assert.equal(key,'wallet-key');return {assets:async()=>{reads++;return {assets:[{symbol:'BTC',name:'Bitcoin',kind:'crypto',price_usd:1},{symbol:'AAPL',name:'Apple',kind:'stock',secret:'omit'}]};}};};
  const result=await f.agents.assets(a.id);assert.deepEqual(result.assets.map(a=>a.kind),['crypto','stock']);assert.ok(!JSON.stringify(result).includes('secret'));await f.agents.assets(a.id);assert.equal(reads,1);
 }finally{await f.close();}
});

function fakeApi() { let id=100;const orders=[];const closes=[];const positions=[];const closed=[];return {key:'wallet-key',orders,closes,
 learn:async()=>({learn_version:'v1'}),documentation:async()=>({version:'1.17',open:{},close:{}}),
 account:async()=>({balance_usdg:1000,open:positions,closed}),assets:async()=>({assets:[{symbol:'BTC',price_usd:100,kind:'crypto'},{symbol:'AAPL',price_usd:20,kind:'stock'}]}),
 open:async body=>{orders.push(body);const position={...body,id:++id,status:'open'};positions.push(position);return {position};},
 close:async body=>{closes.push(body);const index=positions.findIndex(p=>p.id===body.id);if(index>=0){closed.push({...positions[index],pnl:1});positions.splice(index,1);}return {pnl:1};},heartbeat:async()=>({}),version:async()=>({learn_version:'v1',version:'1.17',must_relearn:false})}; }
const decision={reason:'Se cumple la instrucción',actions:[{type:'open',symbol:'BTC',direction:'long',margin:25,leverage:2,closeAfterMinutes:1,reason:'Entrada por estrategia'}]};

test('agent mode reads custom data, asks the model, persists intent before execution, throttles and closes on its stored deadline',async()=>{
 const f=await fixture();try{
  let a=(await f.agents.list()).agents[0];a=await f.agents.update(a.id,config(a,{engine:'agent',apiKey:'wallet-key',enabled:true,mode:'live',connections:[ai,source]}));
  let now=new Date('2026-10-08T16:00:00Z');const api=fakeApi();let modelCalls=0;const realOpen=api.open;
  api.open=async body=>{const persisted=JSON.parse(fs.readFileSync(f.workspace.file,'utf8'));assert.ok(Object.values(persisted.agents[0].state.days).some(day=>Object.values(day).some(r=>r.status==='pending')));return realOpen(body);};
  const read=async(url,options)=>{if(url.includes('data.example.com')){assert.equal(options.headers['X-API-Key'],source.apiKey);return {price:100};}modelCalls++;assert.ok(options.body.messages[1].content.includes('Fuente'));assert.ok(!options.body.messages[1].content.includes(ai.apiKey));assert.equal(options.body.model,ai.model);return {choices:[{message:{content:JSON.stringify(modelCalls===1?decision:{reason:'Esperar',actions:[]})}}]};};
  const agents=new Agents(f.workspace,()=>api,()=>now,read);await agents.tick();await agents.tick();assert.equal(api.orders.length,1);assert.equal(modelCalls,1);
  now=new Date('2026-10-08T16:01:01Z');await agents.tick();assert.equal(api.closes.length,1);assert.equal(api.closes[0].id,101);
  const result=(await agents.list()).agents[0];assert.ok(result.events.some(e=>e.event==='agent_decision'));assert.equal(result.positions[0].status,'closed');
 }finally{await f.close();}
});

test('agent test mode records proposals without sending any trade and a timeout is never retried after restart',async()=>{
 const f=await fixture();try{
  let a=(await f.agents.list()).agents[0];a=await f.agents.update(a.id,config(a,{engine:'agent',apiKey:'wallet-key',enabled:true,connections:[ai]}));
  const api=fakeApi();const read=async()=>({choices:[{message:{content:JSON.stringify(decision)}}]});const agents=new Agents(f.workspace,()=>api,()=>new Date('2026-10-08T16:00:00Z'),read);await agents.tick();assert.equal(api.orders.length,0);assert.ok((await agents.list()).agents[0].events.some(e=>e.event==='dry_run'));
  a=await agents.update(a.id,config(a,{mode:'live'}));api.open=async()=>{throw new ApiError('timeout',true);};await agents.tick();
  a=(await agents.list()).agents[0];assert.ok(a.paused);await f.workspace.run(data=>assert.ok(Object.values(data.agents[0].state.days).some(day=>Object.values(day).some(r=>r.status==='pending'))));
  let calls=0;api.open=async()=>{calls++;};await agents.tick();assert.equal(calls,0);
 }finally{await f.close();}
});

test('decision validation rejects over-budget positions, foreign closes, unsupported assets and duplicate orders',()=>{
 const context={assets:[{symbol:'BTC',price_usd:1}],account:{balance_usdg:100,open:[{id:1}]},positions:[{id:1,status:'open'}],available:30};
 assert.equal(validateDecision(decision,context).actions.length,1);
 for(const action of [{...decision.actions[0],margin:31},{...decision.actions[0],symbol:'INVALID'},{type:'close',id:99,reason:'foreign'},{...decision.actions[0],url:'https://evil.example'}])assert.throws(()=>validateDecision({reason:'bad',actions:[action]},context));
 assert.throws(()=>validateDecision({reason:'bad',actions:[decision.actions[0],decision.actions[0]]},context));
});

test('bot entries use independent symbol, margin, direction and leverage under the space capital budget',async()=>{
 const f=await fixture();try{
  let a=(await f.agents.list()).agents[0];a=await f.agents.update(a.id,config(a,{apiKey:'wallet-key',mode:'live',enabled:true,entries:[{symbol:'BTC',margin:12,leverage:2,direction:'long'},{symbol:'AAPL',margin:20,leverage:3,direction:'short'}]}));
  await f.workspace.run(data=>{data.agents[0].startedAt='2026-10-08T16:24:00Z';});const api=fakeApi();const agents=new Agents(f.workspace,()=>api,()=>new Date('2026-10-08T16:25:00Z'));await agents.tick();assert.equal(api.orders.length,2);assert.equal(api.orders[1].symbol,'AAPL');assert.equal(api.orders[1].size_usd,20);assert.equal(api.orders[1].direction,'short');assert.equal(api.orders[1].leverage,3);
 }finally{await f.close();}
});

test('delete and catalogue HTTP routes enforce authentication, origin checking and pending-position protection',async()=>{
 const f=await fixture();const password='feature-dashboard-password';const headers={Authorization:`Basic ${Buffer.from('admin:'+password).toString('base64')}`,'Content-Type':'application/json'};
 const server=await createDashboard({agents:f.agents,password,host:'127.0.0.1',port:0});const base=`http://127.0.0.1:${server.address().port}`;
 try{const a=(await f.agents.list()).agents[0];assert.equal((await fetch(`${base}/api/agents/${a.id}/assets`)).status,401);assert.equal((await fetch(`${base}/api/agents/${a.id}`,{method:'DELETE',headers:{...headers,Origin:'https://evil.example'},body:'{}'})).status,403);assert.equal((await fetch(`${base}/api/agents/${a.id}`,{method:'DELETE',headers,body:'{}'})).status,200);assert.equal((await f.agents.list()).agents.length,0);}finally{server.closeAllConnections();await new Promise(r=>server.close(r));await f.close();}
});
