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
  if(scenario==='reviewScope')await writeFile(join(project,'review-context.md'),'整体需求含任务一 value.mjs 和任务二 other.mjs；每项只审查自身交付。\n');
  await exec('git', ['init', project]); await exec('git', ['-C', project, 'add', '.']);
  await exec('git', ['-C', project, '-c', 'user.name=Fixture', '-c', 'user.email=test@invalid.local', '-c', 'commit.gpgsign=false', 'commit', '-m', 'baseline']);
  const original = (await manifest(project)).hash, sourceKey = randomUUID();
  const snapshots: CollaborationSnapshot[] = [];
  let sourceTurns = 0, workerCount = 0, failed = false, sends=0;
  const workerAttempts=new Map<string,number>();
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
      const attempt=(workerAttempts.get(input.sessionKey)??0)+1;workerAttempts.set(input.sessionKey,attempt);
      if(++workerCount===2)openBarrier(); await barrier;
      if(scenario==='answeredScopes'&&attempt===2){
        await input.research!.tools!.find(tool=>tool.name==='request_context')!.execute({requestKey:'scope',question:'确认本任务的独立范围',requiresUser:true});
        execution.acceptOutcome({sessionKey:input.sessionKey,agent:input.agent,executionTurnId:input.executionTurnId!,nativeSessionId:`native-${input.sessionKey}`,outcome:'succeeded',text:'已请求澄清'});return {sessionKey:input.sessionKey};
      }
      if(scenario==='transportFailure' && input.agent==='codex' && !failed){failed=true;execution.acceptOutcome({sessionKey:input.sessionKey,agent:input.agent,executionTurnId:input.executionTurnId!,nativeSessionId:`native-${input.sessionKey}`,outcome:'failed',text:'',error:'真实传输边界的受控失败'});return {sessionKey:input.sessionKey};}
      const path=['disjoint','reviewScope','answeredScopes'].includes(scenario)&&input.agent==='codex'?'other.mjs':'value.mjs';
      const content=`export const value = ${input.agent==='claude'?1:2};\n`;
      const write=input.research!.tools!.find(tool=>tool.name==='write_file')!;
      await expect(write.execute({path:'unauthorized.mjs',expectedHash:null,content:'outside'})).rejects.toThrow(/范围/);
      const current=await readFile(join(input.projectPath,path));
      const {createHash}=await import('node:crypto');
      await write.execute({path,expectedHash:createHash('sha256').update(current).digest('hex'),content});
      if(scenario==='outsideScope' && input.agent==='codex' && !failed){failed=true;await writeFile(join(input.projectPath,'outside.txt'),'manual outside change');}
      text=JSON.stringify({summary:'独立修改',findings:[{id:'value',title:'值',detail:'当前候选',evidence:[{path,startLine:1,endLine:1,quote:content.trimEnd()}]}],limitations:[]});
    }else if(scenario==='answeredScopes'){
      const data=JSON.parse(input.text.slice(input.text.indexOf('{')));
      const answered=JSON.parse(data.context??'[]').some((message:{type:string})=>message.type==='answer');
      text=JSON.stringify({verdict:answered?'approved':'changesRequested',summary:'核对本任务上下文',issues:answered?[]:[{id:'scope',blocking:true,location:'任务范围',reason:'需要澄清',evidence:'尚未收到当前任务回复',suggestion:'请求范围确认后再审查'}]});
    }else if(scenario==='reviewScope'){
      // 外部审查传输读取宿主任务契约，不以整个参考文件替代本任务范围。
      const data=JSON.parse(input.text.slice(input.text.indexOf('{')));
      const path=data.version.changes[0].path;
      const expectedObjective=path==='value.mjs'?'任务一':'任务二';
      const bounded=data.scope?.objective===expectedObjective&&JSON.stringify(data.scope?.allowedPaths)===JSON.stringify([path]);
      text=JSON.stringify({verdict:bounded?'approved':'inconclusive',summary:bounded?'仅审查本任务，其他任务保留为组合验收':'宿主缺少当前任务目标与授权范围',issues:[]});
    }else{text=JSON.stringify({verdict:'approved',summary:'范围和检查通过',issues:[]});}
    execution.acceptOutcome({sessionKey:input.sessionKey,agent:input.agent,executionTurnId:input.executionTurnId!,nativeSessionId:`native-${input.sessionKey}`,outcome:'succeeded',text});
    return {sessionKey:input.sessionKey};
  }});
  const repository=new CollaborationRepository(join(root,'records'));
  const service=new CollaborationService(repository,execution,agents,snapshot=>snapshots.push(snapshot),'darwin');
  return {root,project,original,sourceKey,snapshots,repository,service,execution,agents,sends:()=>sends};
}
