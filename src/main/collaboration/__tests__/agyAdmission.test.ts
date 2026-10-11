// 从公开启动入口验证新后端权限/模型准入；拒绝时不派发、不产生可恢复 Run。
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { CollaborationStartParams } from '../../../shared/collaboration.js';
import type { AgentKind } from '../../../shared/types.js';
import type { AgentProvider } from '../../agents/types.js';
import { AgentRegistry } from '../../agents/registry.js';
import { SessionExecutionService } from '../../sessions/sessionExecutionService.js';
import { CollaborationRepository } from '../collaborationRepository.js';
import { CollaborationService } from '../collaborationService.js';

it.each([
  {executor:{agent:'agy'},error:'Gemini 模型'},
  {executor:{agent:'agy',model:'gemini-not-returned'},error:'Gemini 模型'},
  {executor:{agent:'agy',model:'claude-fixture'},error:'Gemini 模型'},
  {executor:{agent:'codex'},reviewer:{agent:'agy'},error:'Gemini 模型'},
  {executor:{agent:'agy',model:'gemini-fixture'},code:{admissionHash:'0'.repeat(64),checks:['node-test']},error:'代码写入准入'},
] satisfies (Pick<CollaborationStartParams,'executor'|'reviewer'|'code'> & {error:string})[])('拒绝不满足 agy 准入的配置 $error',async ({error,...configuration})=>{
  const root=await mkdtemp(join(tmpdir(),'hcode-agy-admission-')),key=randomUUID();let sends=0;
  const agents=new AgentRegistry(Object.fromEntries((['claude','codex','agy'] as const).map(kind=>[kind,{kind,getStatus:async()=>({found:true,version:kind==='agy'?'1.3.3':kind==='codex'?'0.162.0':'test'}),listModels:async()=>[{value:'gemini-fixture',label:'Gemini'},{value:'claude-fixture',label:'Claude'}]}])) as unknown as Record<AgentKind,AgentProvider>);
  const execution=new SessionExecutionService({prepare:async input=>input,send:async input=>{sends++;return {sessionKey:input.sessionKey};},interrupt:async()=>{},failedToSend:()=>{},finishedSending:()=>{}});
  const service=new CollaborationService(new CollaborationRepository(join(root,'records')),execution,agents,()=>{},'darwin');
  try {
    await expect(service.start({initiator:{agent:'claude',sessionKey:key,projectPath:root,permissionMode:'default'},objective:'只读调研',...configuration})).rejects.toThrow(error);
    expect(sends).toBe(0);expect(await service.list(key)).toEqual([]);
  }finally{service.dispose();await rm(root,{recursive:true,force:true});}
});
