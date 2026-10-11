// 原生模型 IO 使用脚本替身；候选、检查子进程、报告证据和仓库使用真实实现。
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { CodeDeliveryState } from '../../../../shared/codeDelivery.js';
import type { DeliverySnapshot } from '../../../../shared/collaboration.js';
import { CollaborationRepository } from '../../collaborationRepository.js';
import { CodeDeliveryWorkflow } from '../codeDeliveryWorkflow.js';
import { WorkspaceService } from '../workspaceService.js';
import { findExecutable } from '../../../util/locateCli.js';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const approved = JSON.stringify({ verdict:'approved', summary:'通过', issues:[] });
const blocked = JSON.stringify({ verdict:'changesRequested', summary:'缺少边界', issues:[{id:'B1', blocking:true,location:'answer.mjs',reason:'负数错误',evidence:'返回1',suggestion:'返回42'}] });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'hcode-code-flow-')); roots.push(root);
  const source = join(root, 'source'); await mkdir(source); await writeFile(join(source, 'answer.mjs'), 'export const answer = 1;\n');
  await writeFile(join(source, 'check.mjs'), "import { answer } from './answer.mjs';\nif (answer !== 42) process.exitCode = 1;\n");
  const runId = randomUUID(), workspaces = new WorkspaceService(join(root, 'records'));
  const workspace = await workspaces.create(source, runId);
  workspace.admission.checks = [{id:'node-test',executable:findExecutable('node', process.env)!,args:['check.mjs'],description:'actual check'}];
  const code: CodeDeliveryState = {workspace,versions:[],validations:[],phase:'execution'};
  const delivery: DeliverySnapshot = {id:randomUUID(),requestKey:'one',objective:'答案为42',executor:{agent:'codex'},status:'queued',versions:[],reviews:[]};
  const report = async () => { const quote = (await readFile(join(workspace.path, 'answer.mjs'), 'utf8')).trimEnd(); return JSON.stringify({summary:'真实变更',findings:[{id:'change',title:'值',detail:'候选实现',evidence:[{path:'answer.mjs',startLine:1,endLine:1,quote}]}],limitations:[]}); };
  return {root:source,runId,workspaces,code,delivery,report,repository:new CollaborationRepository(join(root,'records')),changed:async()=>{},signal:new AbortController().signal};
}
it.skipIf(process.platform !== 'darwin')('检查失败即使模型审查通过也不交付，两次修订后保留真实失败记录', async () => {
  const data = await fixture();
  const workflow = new CodeDeliveryWorkflow({...data,execute:async(role,key)=>({sessionKey:key,agent:role==='review'?'claude':'codex',executionTurnId:randomUUID(),outcome:'succeeded',text:role==='review'?approved:await data.report()})});
  await expect(workflow.run(data.delivery, randomUUID())).rejects.toThrow(/上限/);
  expect(data.code.validations).toHaveLength(3);
  expect(data.code.validations.every((entry)=>entry.status==='failed' && entry.exitCode===1)).toBe(true);
  expect(data.delivery.status).not.toBe('accepted');
  expect(data.delivery.reviews).toHaveLength(3);
});
it.skipIf(process.platform !== 'darwin')('真实写入→失败验证与阻塞审查→同工作区修订→同版本检查通过才生成候选', async () => {
  const data = await fixture(); let executions = 0;
  const workflow = new CodeDeliveryWorkflow({...data,execute:async(role,key,_text,_schema,_delivery,tools)=>{
    if(role==='execution' && ++executions===2) await tools!.find((tool)=>tool.name==='write_file')!.execute({path:'answer.mjs',expectedHash:await data.workspaces.fileHash(data.code.workspace,'answer.mjs'),content:'export const answer = 42;\n'});
    return {sessionKey:key,agent:role==='review'?'claude':'codex',executionTurnId:randomUUID(),outcome:'succeeded',text:role==='review'?(executions===1?blocked:approved):await data.report()};
  }});
  await workflow.run(data.delivery, randomUUID());
  expect(data.delivery.status).toBe('accepted'); expect(data.code.phase).toBe('candidate');
  expect(data.code.validations.map((entry)=>entry.status)).toEqual(['failed','passed']);
  expect(data.code.validations.at(-1)!.versionHash).toBe(data.code.versions.at(-1)!.hash);
  expect(await readFile(join(data.root,'answer.mjs'),'utf8')).toBe('export const answer = 1;\n');
});
it.skipIf(process.platform !== 'darwin')('审查期间人工修改候选使通过失效，停止未知时写入租约不释放', async () => {
  const data = await fixture();
  const workflow = new CodeDeliveryWorkflow({...data,execute:async(role,key)=>{
    if(role==='review') await writeFile(join(data.code.workspace.path,'answer.mjs'),'export const answer = 0;\n');
    return {sessionKey:key,agent:role==='review'?'claude':'codex',executionTurnId:randomUUID(),outcome:'succeeded',text:role==='review'?approved:await data.report()};
  }});
  await expect(workflow.run(data.delivery,randomUUID())).rejects.toThrow(/变化/);
  expect(data.delivery.status).not.toBe('accepted');
  const unknown = await fixture();
  const stopped = new CodeDeliveryWorkflow({...unknown,execute:async(_role,key)=>({sessionKey:key,agent:'codex',executionTurnId:randomUUID(),outcome:'interrupted',text:'',error:'未收到原生中断确认'})});
  await expect(stopped.run(unknown.delivery,randomUUID())).rejects.toThrow(/未收到/);
  expect(unknown.code.stopUnconfirmed).toBe(true);
  expect(unknown.workspaces.isLeased(unknown.code.workspace.id)).toBe(true);
});
