// 从实际项目配置发现可确认的检查；模型不能提交任意 shell，脚本仍在 OS 沙箱内运行。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { CodeAdmission, ValidationCheck } from '../../../shared/codeDelivery.js';
import { findExecutable } from '../../util/locateCli.js';
import { normalizeValidationCommand } from './validationRuntime.js';
import { manifest } from './fileManifest.js';
const exec = promisify(execFile);
const SCRIPT_CHECKS = ['typecheck', 'test', 'build'] as const;
export async function inspectCodeProject(path: string, env: NodeJS.ProcessEnv = process.env): Promise<CodeAdmission> {
  if (process.platform !== 'darwin') throw new Error('代码验证沙箱目前仅在 macOS 验证通过');
  const root = await realpath(path), files = await manifest(root);
  if (files.entries.some((entry) => entry.path.endsWith('.gitmodules'))) throw new Error('首版代码工作区不支持 submodule');
  const git = findExecutable('git', env), node = findExecutable('node', env), pnpm = findExecutable('pnpm', env);
  if (!git || !node) throw new Error('缺少 Git 或 Node 运行时，不能开放代码工作区');
  const options = { timeout: 15_000, maxBuffer: 512 * 1024, env: { ...env, GIT_OPTIONAL_LOCKS: '0' } };
  const status = await exec(git, ['-c', 'core.fsmonitor=false', '-C', root, 'status', '--porcelain=v1', '--untracked-files=all'], options);
  const revision = await exec(git, ['-C', root, 'rev-parse', '--verify', 'HEAD'], options);
  const packageEntry = files.entries.find((entry) => entry.path === 'package.json');
  if (!packageEntry) throw new Error('首版代码验证仅支持含 package.json 的普通 Node Git 项目');
  const packageJson = z.object({ scripts: z.record(z.string(), z.string()).optional() }).passthrough().parse(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')));
  const checks: ValidationCheck[] = [];
  for (const id of SCRIPT_CHECKS) {
    if (!packageJson.scripts?.[id] || !pnpm) continue;
    const scripts = Object.fromEntries([`pre${id}`, id, `post${id}`].filter((key) => packageJson.scripts?.[key]).map((key) => [key, packageJson.scripts![key]!]));
    const command = await normalizeValidationCommand(pnpm, ['run', id]);
    checks.push({ id, ...command, scripts, description: Object.entries(scripts).map(([name, body]) => `${name}: ${body}`).join('\n') });
  }
  if (!checks.length) checks.push({ id: 'node-test', executable: node, args: ['--test'], description: 'Node 内置测试；无包管理器依赖安装' });
  return { hash: files.hash, fileCount: files.entries.length, bytes: files.bytes, checks, gitStatus: status.stdout, sourceRevision: revision.stdout.trim(), strategy: 'full-copy' };
}
