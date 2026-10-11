// 外部 CLI 传输替身配合真实文件、验证进程与仓库，验证同名文件的并行写入隔离。
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'vitest';
import type { CollaborationSnapshot } from '../../../shared/collaboration.js';
import type { AgentKind } from '../../../shared/types.js';
import type { AgentProvider } from '../../agents/types.js';
import { AgentRegistry } from '../../agents/registry.js';
import { SessionExecutionService } from '../../sessions/sessionExecutionService.js';
import { CollaborationRepository } from '../collaborationRepository.js';
import { CollaborationService } from '../collaborationService.js';
import { manifest } from '../workspaces/fileManifest.js';
const exec = promisify(execFile);

export async function parallelFixture(scenario: string) {
  const root = await mkdtemp(join(tmpdir(), 'hcode-parallel-code-'));
  const project = join(root, 'project'); await mkdir(project);
  await writeFile(join(project, 'package.json'), '{"private":true,"type":"module"}');
  await writeFile(join(project, 'other.mjs'), 'export const value = 0;\n');
  await writeFile(join(project, 'value.mjs'), 'export const value = 0;\n');
  await writeFile(join(project, 'value.test.mjs'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { value } from './value.mjs';\ntest('value',()=>assert.ok(value >= 0));\n");
  await exec('git', ['init', project]); await exec('git', ['-C', project, 'add', '.']);
  await exec('git', ['-C', project, '-c', 'user.name=Fixture', '-c', 'user.email=test@invalid.local', '-c', 'commit.gpgsign=false', 'commit', '-m', 'baseline']);
  const original = (await manifest(project)).hash, sourceKey = randomUUID();
  const snapshots: CollaborationSnapshot[] = [];
  let sourceTurns = 0, workerCount = 0, failed = false, sends=0;
  let openBarrier!: () => void;
  const barrier = new Promise<void>(resolve => { openBarrier = resolve; });
  const provider = (kind: 'claude'|'codex') => ({kind, getStatus:async()=>({kind,found:true,version:kind==='codex'?'0.162.0':'test'}),hasSession:()=>true,endResearch:async()=>{}});
  const agents = new AgentRegistry({claude:provider('claude'),codex:provider('codex')} as unknown as Record<AgentKind,AgentProvider>);
  let execution: SessionExecutionService;
  execution = new SessionExecutionService({prepare:async input=>input,interrupt:async()=>{},failedToSend:()=>{},finishedSending:()=>{},send:async input=>{
    sends++;
    let text: string;
    if(input.sessionKey===sourceKey){
      const tools=input.research!.tools!, delegate=tools.find(tool=>tool.name==='delegate_task')!;
      if(++sourceTurns===1){
        await expect(delegate.execute({requestKey:'unauthorized',objective:'扩大任务'})).rejects.toThrow(/确认/);
        const first=await delegate.execute({requestKey:'one',objective:'任务一'}) as {taskId:string};
        expect(await delegate.execute({requestKey:'one',objective:'任务一'})).toEqual(first);
        const second=await delegate.execute({requestKey:'two',objective:'任务二'}) as {taskId:string};
        await tools.find(tool=>tool.name==='wait_tasks')!.execute({taskIds:[first.taskId,second.taskId]});
        text='已派发';
      }else{text='两个独立候选已审查，等待用户逐任务采纳。';}
    }else if(input.research!.tools?.some(tool=>tool.name==='write_file')){
      if(++workerCount===2)openBarrier(); await barrier;
      if(scenario==='transportFailure' && input.agent==='codex' && !failed){failed=true;execution.acceptOutcome({sessionKey:input.sessionKey,agent:input.agent,executionTurnId:input.executionTurnId!,nativeSessionId:`native-${input.sessionKey}`,outcome:'failed',text:'',error:'真实传输边界的受控失败'});return {sessionKey:input.sessionKey};}
      const path=scenario==='disjoint'&&input.agent==='codex'?'other.mjs':'value.mjs';
      const content=`export const value = ${input.agent==='claude'?1:2};\n`;
      const write=input.research!.tools!.find(tool=>tool.name==='write_file')!;
      await expect(write.execute({path:'unauthorized.mjs',expectedHash:null,content:'outside'})).rejects.toThrow(/范围/);
      const current=await readFile(join(input.projectPath,path));
      const {createHash}=await import('node:crypto');
      await write.execute({path,expectedHash:createHash('sha256').update(current).digest('hex'),content});
      if(scenario==='outsideScope' && input.agent==='codex' && !failed){failed=true;await writeFile(join(input.projectPath,'outside.txt'),'manual outside change');}
      text=JSON.stringify({summary:'独立修改',findings:[{id:'value',title:'值',detail:'当前候选',evidence:[{path,startLine:1,endLine:1,quote:content.trimEnd()}]}],limitations:[]});
    }else{text=JSON.stringify({verdict:'approved',summary:'范围和检查通过',issues:[]});}
    execution.acceptOutcome({sessionKey:input.sessionKey,agent:input.agent,executionTurnId:input.executionTurnId!,nativeSessionId:`native-${input.sessionKey}`,outcome:'succeeded',text});
    return {sessionKey:input.sessionKey};
  }});
  const repository=new CollaborationRepository(join(root,'records'));
  const service=new CollaborationService(repository,execution,agents,snapshot=>snapshots.push(snapshot),'darwin');
  return {root,project,original,sourceKey,snapshots,repository,service,execution,agents,sends:()=>sends};
}
