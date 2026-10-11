// 真实原生委派两个写后端，验证同时执行、阻塞修订、逐候选采纳及冲突拒绝。
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
vi.mock('../../util/trash.js',()=>({trashPaths:async()=>{throw new Error('不得删除原生会话');}}));
import { nativeFixture } from './nativeFixture.js';
import { manifest } from '../workspaces/fileManifest.js';
const exec=promisify(execFile);
const require=createRequire(import.meta.url);
const ZERO_TASK='divide.mjs 对任何 divisor === 0（0/0、负数/0、-0）抛 RangeError；正常、负数和非零除法保持正确。保留原始测试，新增 zero.test.mjs 完整覆盖这些边界。缺少任一边界或测试是阻塞问题。';
const FINITE_TASK='divide.mjs 对任一参数为 NaN、Infinity、-Infinity 或非 number 抛 TypeError；普通正负数除法保持原行为。不处理除零新规则。保留原始测试，新增 finite.test.mjs 覆盖两个参数、所有非有限值和错误类型。';
it.skipIf(process.env.HCODE_NATIVE_PARALLEL_CODE!=='1')('真实 Codex 会话同时委派 Claude/Codex，真实阻塞修订复审与逐任务安全采纳',async()=>{
  let first=true,overlap=false;
  const data=await nativeFixture('hcode-s5b-parallel-native-',input=>{
    const writer=input.research?.tools?.some(tool=>tool.name==='write_file');
    if(writer && input.agent==='claude' && first){first=false;return {...input,text:'你是隔离代码执行者。只用宿主 read_file/list_files/write_file/delete_file，不执行命令。此验收初版仅在 divide.mjs 对 value > 0 && divisor === 0 抛 RangeError，其他保持原行为；保留原始测试，新增 zero.test.mjs 只测试正数除零，暂时故意遗漏 0/0、负数除零和 -0。独立审查将指出完整目标，随后必须按审查修订。仅允许 divide.mjs 和 zero.test.mjs。write_file 必须匹配 read_file 的 hash，新文件为 null。完成后重新读文件，按 output schema 报告真实修改。证据只引用一条独立、完整的实际源码行，保留原始空格，startLine=endLine；不能将多行拼为一行。不能声称已运行测试。'};}
    return writer?{...input,text:input.text+'\n报告证据只引用一条实际完整原始行，startLine=endLine，保留原始空格；重新读取再核对。'}:input;
  },snapshot=>{if(snapshot.tasks.filter(task=>task.role==='execution'&&task.status==='running').length>=2)overlap=true;});
  try{
    const project=join(data.root,'project');await mkdir(project);
    // 使用本机实际安装的依赖，验证候选副本可运行依赖测试而不读取原项目或联网安装。
    const dependencyRoot=dirname(dirname(require.resolve('smol-toml')));
    await mkdir(join(project,'node_modules'),{recursive:true});
    await cp(dependencyRoot,join(project,'node_modules','smol-toml'),{recursive:true});
    await writeFile(join(project,'package.json'),'{"name":"hcode-parallel-native-fixture","private":true,"type":"module","dependencies":{"smol-toml":"1.9.1"}}');
    await writeFile(join(project,'.gitignore'),'node_modules/\n');
    await writeFile(join(project,'divide.mjs'),'export function divide(value, divisor) {\n  return value / divisor;\n}\n');
    await writeFile(join(project,'baseline.test.mjs'),"import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { parse } from 'smol-toml';\nimport { divide } from './divide.mjs';\ntest('normal division with installed dependency',()=>{const values=parse('value = 8\\ndivisor = 2');assert.equal(divide(values.value, values.divisor),4);assert.equal(divide(-6,3),-2);});\n");
    await exec('git',['init',project]);await exec('git',['-C',project,'add','.']);
    await exec('git',['-C',project,'-c','user.name=Fixture','-c','user.email=test@invalid.local','-c','commit.gpgsign=false','commit','-m','baseline']);
    await writeFile(join(project,'untracked.txt'),'retain user context');
    const original=await manifest(project),admission=await data.service.inspectCodeProject(project);
    const run=await data.service.start({initiator:{agent:'codex',sessionKey:randomUUID(),projectPath:project,permissionMode:'default'},executor:{agent:'claude',model:'sonnet'},objective:'先同时派发用户确认的两个任务，Claude 和 Codex 各自独立修改同名 divide.mjs，然后等候自动验证、独立审查与有界修订，汇总每项真实候选。只生成独立候选，不合并，不采纳原项目。',code:{admissionHash:admission.hash,checks:['node-test'],tasks:[{requestKey:'zero-boundary',objective:ZERO_TASK,executor:{agent:'claude',model:'sonnet'},allowedPaths:['divide.mjs','zero.test.mjs']},{requestKey:'finite-boundary',objective:FINITE_TASK,executor:{agent:'codex'},allowedPaths:['divide.mjs','finite.test.mjs']}]}});
    await vi.waitFor(()=>expect(data.latest()?.stage).toBe('finished'),{timeout:660_000,interval:1000});
    const result=await data.service.get(run.id),[zero,finite]=result.deliveries;
    expect(result.status,JSON.stringify(result)).toBe('completed');expect(overlap).toBe(true);
    expect(zero!.reviews[0]!.verdict).toBe('changesRequested');expect(zero!.reviews.at(-1)!.verdict).toBe('approved');
    expect(zero!.code!.versions.length).toBeGreaterThanOrEqual(2);expect(finite!.reviews.at(-1)!.verdict).toBe('approved');
    expect(zero!.code!.workspace.path).not.toBe(finite!.code!.workspace.path);expect(zero!.code!.workspace.baselineHash).toBe(original.hash);expect(finite!.code!.workspace.baselineHash).toBe(original.hash);
    expect((await manifest(project)).hash).toBe(original.hash);
    const chosen=zero!.code!.versions.at(-1)!,other=finite!.code!.versions.at(-1)!;
    const ready=await data.service.adoptionPreview(run.id,chosen.id),alternative=await data.service.adoptionPreview(run.id,other.id);
    expect(ready.eligible,JSON.stringify(ready)).toBe(true);expect(alternative.eligible,JSON.stringify(alternative)).toBe(true);
    const applied=await data.service.applyCandidate(run.id,{versionId:chosen.id,previewHash:ready.hash});
    expect(applied.status).toBe('applied');expect(applied.cleanupPending).toBe(false);
    const conflict=await data.service.adoptionPreview(run.id,other.id);
    expect(conflict.conflicts.map(entry=>entry.path)).toContain('divide.mjs');
    await expect(data.service.applyCandidate(run.id,{versionId:other.id,previewHash:alternative.hash})).rejects.toThrow(/偏离/);
    const checked=await exec(process.execPath,['--test'],{cwd:project});expect(checked.stdout).toContain('fail 0');
    expect(await readFile(join(project,'untracked.txt'),'utf8')).toBe('retain user context');
    const restored=await data.service.get(run.id);expect(restored.deliveries[0]!.code!.adoption?.status).toBe('applied');expect(restored.deliveries[1]!.code!.adoption).toBeUndefined();
    if(process.env.HCODE_NATIVE_EVIDENCE_DIR){
      await mkdir(process.env.HCODE_NATIVE_EVIDENCE_DIR,{recursive:true});
      await cp(project,join(process.env.HCODE_NATIVE_EVIDENCE_DIR,'original-after-adoption'),{recursive:true});
      await writeFile(join(process.env.HCODE_NATIVE_EVIDENCE_DIR,'parallel-verification.json'),JSON.stringify({runId:run.id,overlap,baselineHash:original.hash,checks:checked.stdout,applied,conflict,source:result.params.initiator,tasks:result.tasks},null,2));
    }
  }finally{await data.cleanup();}
},720_000);
