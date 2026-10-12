// 用真实子进程重放 CLI 事件，验证公开 Session 终态；不替换生命周期或投影规则。
import { mkdtemp, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import type { TurnOutcome } from '../../../../shared/collaboration.js';
import type { ChatStateEvent } from '../../../../shared/types.js';
import { AgySession } from '../agySession.js';

it('协议失败后新回合清空旧错误与响应指标，真实成功结果仍可结算', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hcode-agy-metrics-retry-'));
  const outcomes: TurnOutcome[] = [], states: ChatStateEvent[] = [];
  const program = join(root, 'cli.cjs');
  await writeFile(program, `const fs=require('node:fs');const send=e=>process.stdout.write(JSON.stringify(e)+'\\n');
send({event:'init',conversation_id:'retry-test',init:{}});
process.stdin.once('data',()=>{
  send({event:'step_update',step_update:{step_type:'agent_response',text_delta:'first',state:'RUNNING'}});
  setTimeout(()=>{
    send({event:'step_update',step_update:{step_type:'agent_response',text_delta:'second',state:'DONE'}});
    if(!fs.existsSync('retried')){fs.writeFileSync('retried','yes');process.stdout.write('{malformed\\n');return;}
    send({event:'result',result:{conversation_id:'retry-test',num_turns:1,status:'SUCCESS',response:'done',usage:{input_tokens:20,cache_read_tokens:0,output_tokens:30}}});
  },40);
});`);
  const session = new AgySession({
    resolveLaunch: async () => ({ path: process.execPath, cwd: root, env: process.env as Record<string, string>, args: [program] }),
    emitRows: () => {}, emitState: event => states.push(event), emitTurnOutcome: event => outcomes.push(event), onSettled: () => {},
  }, { key: randomUUID(), projectPath: root, permissionMode: 'default' });
  try {
    await session.send('broken', [], [], 'failed-turn');
    await vi.waitFor(() => expect(outcomes).toHaveLength(1));
    expect(outcomes[0]).toMatchObject({ outcome: 'failed' });
    expect(states.at(-1)?.usage?.ttftMs).toBeDefined();
    const retry = session.send('retry', [], [], 'retry-turn');
    expect(states.at(-1)).toMatchObject({ state: 'running' });
    expect(states.at(-1)?.error).toBeUndefined();
    expect(states.at(-1)?.usage?.ttftMs).toBeUndefined();
    await retry;
    await vi.waitFor(() => expect(outcomes).toHaveLength(2));
    expect(outcomes[1]).toMatchObject({ executionTurnId: 'retry-turn', outcome: 'succeeded' });
    expect(states.at(-1)).toMatchObject({ state: 'idle', usage: { outputTokens: 30 } });
    expect(states.at(-1)?.usage?.ttftMs).toBeDefined();
    expect(states.at(-1)?.usage?.outputTokensPerSecond).toBeGreaterThan(0);
  } finally { session.close(); await rm(root, { recursive: true, force: true }); }
});

it('原生结构化结果归属执行回合，拒绝操作和错误不能成为成功，重复结果只结算一次', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hcode-agy-events-'));
  const nativeId = randomUUID(), outcomes: TurnOutcome[] = [];
  const program = join(root, 'cli.cjs');
  await writeFile(program, `const readline = require('node:readline');
const send = event => process.stdout.write(JSON.stringify(event)+'\\n');
send({event:'init',conversation_id:${JSON.stringify(nativeId)},init:{}});
let turn=0; readline.createInterface({input:process.stdin}).on('line',()=>{
  const result = {conversation_id:${JSON.stringify(nativeId)},num_turns:++turn,status:'SUCCESS',response:'progress\\nnot JSON',structured_output:{summary:'actual report'}};
  if(turn===2) result.denied_actions=['write_to_file'];
  if(turn===3) { result.status='ERROR'; result.error='quota exhausted'; }
  send({event:'result',result}); send({event:'result',result});
});`);
  const session = new AgySession({ resolveLaunch: async () => ({ path: process.execPath, cwd: root, env: process.env as Record<string, string>, args: [program] }), emitRows: () => {}, emitState: () => {}, emitTurnOutcome: (event) => outcomes.push(event), onSettled: () => {} }, { key: randomUUID(), projectPath: root, permissionMode: 'default' });
  try {
    await session.send('one', [], [], 'execution-1');
    await vi.waitFor(() => expect(outcomes).toHaveLength(1), { timeout: 1000 });
    expect(outcomes[0]).toMatchObject({ executionTurnId: 'execution-1', nativeSessionId: nativeId, outcome: 'succeeded', text: '{"summary":"actual report"}' });
    await session.send('two', [], [], 'execution-2');
    await vi.waitFor(() => expect(outcomes).toHaveLength(2));
    expect(outcomes[1]).toMatchObject({ executionTurnId: 'execution-2', outcome: 'failed' });
    expect(outcomes[1]!.error).toContain('write_to_file');
    await session.send('three', [], [], 'execution-3');
    await vi.waitFor(() => expect(outcomes).toHaveLength(3));
    expect(outcomes[2]).toMatchObject({ outcome: 'failed', error: 'quota exhausted' });
  } finally { session.close(); await rm(root, { recursive: true, force: true }); }
});

it.each(['interrupt','close'] as const)('%s 等待原生进程 close；启动期间停止不发送用户回合，也不提前确认', async (control) => {
  const root = await mkdtemp(join(tmpdir(), 'hcode-agy-stop-')), nativeId = randomUUID(), outcomes: TurnOutcome[] = [];
  const program = join(root,'cli.cjs');
  await writeFile(program, `const send=e=>process.stdout.write(JSON.stringify(e)+'\\n');
setTimeout(()=>send({event:'init',conversation_id:${JSON.stringify(nativeId)},init:{}}),100);
process.on('SIGINT',()=>{send({event:'result',result:{conversation_id:${JSON.stringify(nativeId)},status:'ERROR',error:'interrupted',response:'',num_turns:1}});setTimeout(()=>process.exit(0),150)});
process.stdin.on('data',()=>require('node:fs').writeFileSync(${JSON.stringify(join(root,'unexpected-input'))},'sent'));`);
  const session = new AgySession({ resolveLaunch: async()=>({path:process.execPath,cwd:root,env:process.env as Record<string,string>,args:[program]}),emitRows:()=>{},emitState:()=>{},emitTurnOutcome:(event)=>outcomes.push(event),onSettled:()=>{} }, {key:randomUUID(),projectPath:root,permissionMode:'default'});
  try {
    const sending=session.send('must not send',[],[],'cancel-start');
    await session[control]();
    expect(outcomes).toHaveLength(0);
    await sending;
    expect(outcomes).toHaveLength(0);
    await vi.waitFor(()=>expect(outcomes).toHaveLength(1));
    expect(outcomes[0]).toMatchObject({executionTurnId:'cancel-start',outcome:'cancelled'});
    await expect(stat(join(root,'unexpected-input'))).rejects.toThrow();
  } finally {session.close();await rm(root,{recursive:true,force:true});}
});

it('CLI 未返回 result 即退出时明确失败；初始化换原生身份时不发送回合', async () => {
  const root=await mkdtemp(join(tmpdir(),'hcode-agy-exit-')),nativeId=randomUUID(),outcomes:TurnOutcome[]=[];
  const program=join(root,'cli.cjs');
  await writeFile(program,`process.stdout.write(JSON.stringify({event:'init',conversation_id:${JSON.stringify(nativeId)},init:{}})+'\\n');process.stdin.on('data',()=>process.exit(3));`);
  const host={resolveLaunch:async()=>({path:process.execPath,cwd:root,env:process.env as Record<string,string>,args:[program]}),emitRows:()=>{},emitState:()=>{},emitTurnOutcome:(event:TurnOutcome)=>outcomes.push(event),onSettled:()=>{}};
  const session=new AgySession(host,{key:randomUUID(),projectPath:root,permissionMode:'default'});
  const wrong=new AgySession(host,{key:randomUUID(),projectPath:root,sessionId:randomUUID(),permissionMode:'default'});
  try {
    await session.send('exit',[],[],'exit-turn'); await vi.waitFor(()=>expect(outcomes).toHaveLength(1));
    expect(outcomes[0]).toMatchObject({outcome:'failed',executionTurnId:'exit-turn'});
    await wrong.send('wrong identity',[],[],'wrong-turn');
    expect(outcomes.at(-1)?.error).toContain('身份');
    expect(outcomes.at(-1)?.outcome).toBe('failed');
  } finally {session.close();wrong.close();await rm(root,{recursive:true,force:true});}
});

it.each(['{malformed', '{"event":"result","result":null}'])('损坏的 stream-json %s 明确失败，不吞错误或等待到任务超时', async (invalid) => {
  const root=await mkdtemp(join(tmpdir(),'hcode-agy-protocol-')),outcomes:TurnOutcome[]=[];
  const program=join(root,'cli.cjs');
  await writeFile(program,`process.stdout.write(JSON.stringify({event:'init',conversation_id:'native-test',init:{}})+'\\n');process.stdin.on('data',()=>process.stdout.write(${JSON.stringify(invalid+'\n')}));`);
  const session=new AgySession({resolveLaunch:async()=>({path:process.execPath,cwd:root,env:process.env as Record<string,string>,args:[program]}),emitRows:()=>{},emitState:()=>{},emitTurnOutcome:event=>outcomes.push(event),onSettled:()=>{}},{key:randomUUID(),projectPath:root,permissionMode:'default'});
  try {
    await session.send('broken stream',[],[],'protocol-turn');
    await vi.waitFor(()=>expect(outcomes).toHaveLength(1),{timeout:1000});
    expect(outcomes[0]?.outcome).toBe('failed');
    expect(outcomes[0]?.error).toContain('stream-json');
  }finally{session.close();await rm(root,{recursive:true,force:true});}
});

it('原生累计用量缺字段或倒退时显示未知，不以零或累计值伪装本轮用量', async () => {
  const root=await mkdtemp(join(tmpdir(),'hcode-agy-usage-')),outcomes:TurnOutcome[]=[];
  const program=join(root,'cli.cjs');
  await writeFile(program,`const send=e=>process.stdout.write(JSON.stringify(e)+'\\n');send({event:'init',conversation_id:'usage-test',init:{}});let turn=0;require('node:readline').createInterface({input:process.stdin}).on('line',()=>{turn++;const usage=turn===1?{input_tokens:100,cache_read_tokens:20,output_tokens:30}:turn===2?{input_tokens:150}:turn===3?{input_tokens:200,cache_read_tokens:30,output_tokens:40}:{input_tokens:10,cache_read_tokens:0,output_tokens:5};send({event:'result',result:{conversation_id:'usage-test',num_turns:turn,status:'SUCCESS',response:'done',usage}})});`);
  const session=new AgySession({resolveLaunch:async()=>({path:process.execPath,cwd:root,env:process.env as Record<string,string>,args:[program]}),emitRows:()=>{},emitState:()=>{},emitTurnOutcome:event=>outcomes.push(event),onSettled:()=>{}},{key:randomUUID(),projectPath:root,permissionMode:'default'});
  try {
    for(let index=1;index<=4;index++){await session.send('usage',[],[],`usage-${index}`);await vi.waitFor(()=>expect(outcomes).toHaveLength(index));}
    expect(outcomes[0]?.usage).toEqual({inputTokens:120,outputTokens:30});
    expect(outcomes.slice(1).every(outcome=>outcome.usage===undefined)).toBe(true);
  }finally{session.close();await rm(root,{recursive:true,force:true});}
});
