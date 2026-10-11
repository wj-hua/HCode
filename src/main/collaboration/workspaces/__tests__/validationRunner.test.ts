// 使用真实 macOS 沙箱与 Node 子进程验证检查版本、失败、文件漂移及越界拒绝。
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { WorkspaceService } from '../workspaceService.js';
import { ValidationRunner } from '../validationRunner.js';
import { findExecutable } from '../../../util/locateCli.js';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(code: string, setup?: (original: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'hcode-check-')); roots.push(root);
  const original = join(root, 'original'); await mkdir(original); await writeFile(join(original, 'check.mjs'), code);
  if (setup) await setup(original);
  const service = new WorkspaceService(join(root, 'records')); const workspace = await service.create(original, 'test');
  const version = await service.freeze(workspace, 1);
  return { service, workspace, version, original };
}
it.skipIf(process.platform !== 'darwin')('检查真实退出码且不能读取/写入原项目或联网', async () => {
  const data = await fixture(`import {readFileSync, writeFileSync} from 'node:fs';\nimport assert from 'node:assert/strict';\nconst original = ${JSON.stringify('PLACEHOLDER')};\nassert.throws(() => writeFileSync(original + '/escape', 'bad'));\nassert.throws(() => readFileSync(original + '/check.mjs'));\nconst result = await fetch('https://example.com').then(() => true, () => false);\nassert.equal(result, false);\nconsole.log('isolation verified');`);
  const path = join(data.workspace.path, 'check.mjs');
  await writeFile(path, (await readFile(path, 'utf8')).replace('PLACEHOLDER', data.original));
  const version = await data.service.freeze(data.workspace, 2);
  const result = await new ValidationRunner(data.service).run(data.workspace, version, [{ id: 'node-test', executable: findExecutable('node', process.env)!, args: ['check.mjs'], description: 'isolation' }], new AbortController().signal);
  expect(result[0]!.status, result[0]!.stderr).toBe('passed');
  expect(result[0]!.versionHash).toBe(version.hash);
});
it.skipIf(process.platform !== 'darwin')('失败不假通过；检查更改文件不能绑定旧版本', async () => {
  const data = await fixture(`process.exitCode = 1;`);
  const runner = new ValidationRunner(data.service), checks = [{ id: 'node-test' as const, executable: findExecutable('node', process.env)!, args: ['check.mjs'], description: 'check' }];
  expect((await runner.run(data.workspace, data.version, checks, new AbortController().signal))[0]!.status).toBe('failed');
  await writeFile(join(data.workspace.path, 'check.mjs'), `import {writeFileSync} from 'node:fs';writeFileSync('source.txt', 'changed');`);
  const version = await data.service.freeze(data.workspace, 2);
  await expect(runner.run(data.workspace, version, checks, new AbortController().signal)).rejects.toThrow(/变化/);
  expect(data.service.isLeased(data.workspace.id)).toBe(false);
});
it.skipIf(process.platform !== 'darwin')('取消后检查及其子进程停止，租约释放后不再落盘', async () => {
  const data = await fixture(`import { spawn } from 'node:child_process';\nimport { writeFileSync } from 'node:fs';\nconst child = spawn(process.execPath, ['-e', "setInterval(() => require('node:fs').appendFileSync('ticks.txt', 'x'), 30)"], {stdio:'ignore'});\nsetInterval(() => writeFileSync('parent.txt', 'running'), 30);`);
  const runner = new ValidationRunner(data.service), abort = new AbortController();
  const running = runner.run(data.workspace, data.version, [{id:'node-test',executable:findExecutable('node',process.env)!,args:['check.mjs'],description:'cancel'}], abort.signal);
  const failure = expect(running).rejects.toThrow(/变化/);
  await vi.waitFor(async () => expect((await readFile(join(data.workspace.path, "ticks.txt"), "utf8")).length).toBeGreaterThan(0));
  abort.abort();
  await failure;
  expect(data.service.isLeased(data.workspace.id)).toBe(false);
  const ticks = await readFile(join(data.workspace.path, 'ticks.txt'), 'utf8');
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(await readFile(join(data.workspace.path, 'ticks.txt'), 'utf8')).toBe(ticks);
});
it.skipIf(process.platform !== 'darwin')('完整复制 ignored 依赖与内部链接，真实 pnpm 脚本能在副本运行', async () => {
  const data = await fixture(`import {answer} from 'local-dependency'; if(answer!==42) process.exitCode=1;`, async (original) => {
  await mkdir(join(original, 'node_modules', '.store', 'local-dependency'), { recursive: true });
  await writeFile(join(original,'package.json'),'{"type":"module","scripts":{"test":"node check.mjs"}}');
  await writeFile(join(original,'node_modules/.store/local-dependency/package.json'),'{"name":"local-dependency","type":"module","exports":"./index.js"}');
  await writeFile(join(original,'node_modules/.store/local-dependency/index.js'),'export const answer=42;');
  const {symlink} = await import('node:fs/promises'); await symlink('.store/local-dependency',join(original,'node_modules/local-dependency'));
  });
  const version = await data.service.freeze(data.workspace, 2);
  const checks = [{id:'test' as const,executable:findExecutable('pnpm',process.env)!,args:['run','test'],description:'node check.mjs'}];
  const results = await new ValidationRunner(data.service).run(data.workspace,version,checks,new AbortController().signal);
  expect(results[0]!.status,results[0]!.stderr).toBe('passed');
});
it.skipIf(process.platform !== 'darwin')('验证脚本不能遗留脱离进程组的后台写入者', async () => {
  const data = await fixture(`import {spawn} from 'node:child_process';\nconst child = spawn(process.execPath,['-e',"let n=0;const t=setInterval(()=>{require('node:fs').appendFileSync('ticks.txt','x');if(++n===20)clearInterval(t)},30)"],{detached:true,stdio:'ignore'});child.on('error',()=>{});child.unref();setTimeout(()=>{},100);`);
  let result;
  try { result = await new ValidationRunner(data.service).run(data.workspace,data.version,[{id:'node-test',executable:findExecutable('node',process.env)!,args:['check.mjs'],description:'background'}],new AbortController().signal); }
  catch(error) { expect(String(error)).toMatch(/变化/); }
  const ticks = await readFile(join(data.workspace.path,'ticks.txt'),'utf8').catch((error: NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return '';throw error;});
  await new Promise((resolve)=>setTimeout(resolve,150));
  const later = await readFile(join(data.workspace.path,'ticks.txt'),'utf8').catch((error: NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return '';throw error;});
  expect(later).toBe(ticks);
  expect(data.service.isLeased(data.workspace.id)).toBe(false);
});
it.skipIf(process.platform !== 'darwin')('候选改写已授权脚本时拒绝运行，保留错误而非沿用旧授权', async () => {
  const data = await fixture('console.log("approved");', async (original) => {
    await writeFile(join(original, 'package.json'), JSON.stringify({ scripts: { test: 'node check.mjs' } }));
  });
  await writeFile(join(data.workspace.path, 'package.json'), JSON.stringify({ scripts: { test: 'node changed.mjs' } }));
  const version = await data.service.freeze(data.workspace, 2);
  await expect(new ValidationRunner(data.service).run(data.workspace, version, [{ id: 'test', executable: findExecutable('pnpm', process.env)!, args: ['run', 'test'], scripts: { test: 'node check.mjs' }, description: 'approved' }], new AbortController().signal)).rejects.toThrow(/授权的验证脚本已变化/);
  expect(data.service.isLeased(data.workspace.id)).toBe(false);
});
