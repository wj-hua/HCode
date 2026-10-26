// 原生后端能力与当前线程资格分开，历史线程限制不能导致品牌切换或误禁执行能力。
import { expect, it } from 'vitest';
import type { AgentKind } from '../../../shared/types.js';
import type { AgentProvider } from '../../agents/types.js';
import { AgentRegistry } from '../../agents/registry.js';
import { collaborationCapabilities } from '../collaborationCapabilities.js';
it.each(['0.162.0', '0.163.0', '0.164.0', '0.161.0'])('Codex %s 的源资格按版本和当前线程工具核验', async (version) => {
  const agents = new AgentRegistry({ codex: { kind: 'codex', getStatus: async () => ({ found: true, version }), collaborationSourceReason: async () => '旧线程缺工具，不能补工具' } } as unknown as Record<AgentKind, AgentProvider>);
  const fresh = (await collaborationCapabilities(agents, 'darwin'))[0]!;
  expect(fresh.canInitiate).toBe(version !== '0.161.0');
  const existing = (await collaborationCapabilities(agents, 'darwin', { agent: 'codex', resumeSessionId: 'ordinary-thread' }))[0]!;
  expect(existing.canInitiate).toBe(false);
  expect(existing.canExecute).toBe(version !== '0.161.0');
  expect(existing.reason).toContain(version !== '0.161.0' ? '旧线程缺工具' : '尚未验证');
  expect((await collaborationCapabilities(agents, 'linux'))[0]!.canExecute).toBe(false);
});

it('agy 从实时模型列表只开放 Gemini 研究/审查，来源委派、代码写入和未验收版本保持不可用', async () => {
  let version='1.3.3', failed=false;
  const agents=new AgentRegistry({agy:{kind:'agy',getStatus:async()=>({found:true,version}),listModels:async()=>{if(failed)throw new Error('model service unavailable');return [{value:'gemini-fixture',label:'Gemini'},{value:'claude-fixture',label:'Claude'}];}}} as unknown as Record<AgentKind,AgentProvider>);
  expect((await collaborationCapabilities(agents,'darwin'))[0]).toMatchObject({canExecute:true,canReview:true,canInitiate:false,canExecuteCode:false,models:[{value:'gemini-fixture',label:'Gemini'}]});
  expect((await collaborationCapabilities(agents,'linux'))[0]?.canExecute).toBe(false);
  version='1.3.2';expect((await collaborationCapabilities(agents,'darwin'))[0]?.canExecute).toBe(false);
  version='1.3.3';failed=true;
  expect((await collaborationCapabilities(agents,'darwin'))[0]).toMatchObject({canExecute:false,reason:expect.stringContaining('model service unavailable')});
});

