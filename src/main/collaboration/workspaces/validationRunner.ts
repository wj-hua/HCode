// 宿主运行已确认检查：无凭证环境、网络关闭、原项目不可读写；输出/退出码绑定冻结版本。
import { spawn } from 'node:child_process';
import { access, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { CODE_WORKSPACE_LIMITS, type CodeVersion, type CodeWorkspace, type ValidationCheck, type ValidationResult } from '../../../shared/codeDelivery.js';
import { fileURLToPath } from 'node:url';
import { normalizeValidationCommand, validationRuntimeReads } from './validationRuntime.js';
import { confirmProcessGroupStopped } from "./processGroup.js";
import type { WorkspaceService } from './workspaceService.js';

const SYSTEM_READS = ['/System', '/usr', '/bin', '/sbin', '/Library', '/opt/homebrew', '/private/etc', '/etc', '/private/var/db', '/private/var/run', '/dev'];
// Darwin syscall numbers from XNU sys/syscall.h. Blocking posix_spawn also closes its SETSID flag bypass.
const DARWIN_PROCESS_CONTROL_SYSCALLS = { setpgid: 82, setsid: 147, posixSpawn: 244 } as const;
async function validationShim() {
  const bundled = join(dirname(fileURLToPath(import.meta.url)), '../native/validation-fork-only.dylib').replace('app.asar/', 'app.asar.unpacked/');
  const path = import.meta.url.includes('/src/main/') ? resolve('out/native/validation-fork-only.dylib') : bundled;
  await access(path);
  return await realpath(path);
}
function sandboxPath(value: string) { return JSON.stringify(value); }
/** SBPL 只给候选和独立临时区写入；显式 deny 原目录优先于运行时读取白名单。 */
export async function validationSandbox(workspace: CodeWorkspace, scratch: string, executable: string, shim?: string, args: string[] = []) {
  const canonicalScratch = await realpath(scratch);
  const runtimes = await validationRuntimeReads(executable);
  if (args[0]?.endsWith('/pnpm/bin/pnpm.mjs') || args[0]?.endsWith('/pnpm/bin/pnpm.cjs')) runtimes.push(resolve(dirname(args[0]!), '..'));
  const reads = [...SYSTEM_READS, ...runtimes, ...(shim ? [shim] : []), workspace.path, canonicalScratch];
  return `(version 1) (deny default) (allow process-exec) (allow process-fork) (allow process-info* (target same-sandbox)) (allow signal (target same-sandbox)) (allow sysctl-read) (allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo") (global-name "com.apple.system.DirectoryService.libinfo_v1") (global-name "com.apple.system.logger") (global-name "com.apple.logd") (global-name "com.apple.logd.events")) (allow file-read-metadata) (allow file-read* (literal "/"))\n(allow file-read* ${reads.map((path) => `(subpath ${sandboxPath(path)})`).join(' ')})\n(allow file-write* (subpath ${sandboxPath(workspace.path)}) (subpath ${sandboxPath(canonicalScratch)}) (literal "/dev/null"))\n(deny file-read* file-write* (subpath ${sandboxPath(workspace.originalPath)}))\n(deny syscall-unix ${Object.values(DARWIN_PROCESS_CONTROL_SYSCALLS).map((number) => `(syscall-number ${number})`).join(" ")})`;
}
export class ValidationRunner {
  constructor(private readonly workspaces: WorkspaceService) {}
  /** 取得验证租约并等候整个进程组终止；取消不会提前释放给人工接管。 */
  async run(workspace: CodeWorkspace, version: CodeVersion, checks: ValidationCheck[], signal: AbortSignal, record?: (result: ValidationResult) => Promise<void>): Promise<ValidationResult[]> {
    if (process.platform !== 'darwin') throw new Error('当前平台没有已验收的验证进程沙箱');
    const release = this.workspaces.acquire(workspace.id, 'validation');
    let stopped = true;
    try {
      await this.workspaces.assertCurrent(workspace, version);
      const results: ValidationResult[] = [];
      for (const check of checks) {
        if (signal.aborted) throw new Error('验证已取消');
        const result = await this.check(workspace, version, check, signal);
        results.push(result);
        await writeFile(join(this.workspaces.directory(workspace.id), version.id, `${check.id}.json`), JSON.stringify(result), { mode: 0o600 });
        if (record) await record(result);
        await this.workspaces.assertCurrent(workspace, version);
        if (result.status !== 'passed') break;
      }
      return results;
    } catch (error) { if (String(error).includes("验证进程停止未确认")) stopped = false; throw error; }
    finally { if (stopped) release(); }
  }
  private async check(workspace: CodeWorkspace, version: CodeVersion, check: ValidationCheck, signal: AbortSignal): Promise<ValidationResult> {
    if (check.scripts) {
      const packageJson = JSON.parse(await readFile(join(workspace.path, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
      const actual = Object.fromEntries([`pre${check.id}`, check.id, `post${check.id}`].filter((key) => packageJson.scripts?.[key]).map((key) => [key, packageJson.scripts![key]!]));
      if (JSON.stringify(actual) !== JSON.stringify(check.scripts)) throw new Error('用户授权的验证脚本已变化，不能自动运行新命令；请人工处理验证计划');
    }
    const scratch = join(this.workspaces.directory(workspace.id), 'scratch', version.id, check.id);
    await mkdir(scratch, { recursive: true, mode: 0o700 });
    const command = await normalizeValidationCommand(check.executable, check.args);
    const shim = await validationShim();
    const profile = await validationSandbox(workspace, scratch, command.executable, shim, command.args);
    const env = { PATH: `${dirname(check.executable)}:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: scratch, TMPDIR: scratch, CI: '1', LANG: 'en_US.UTF-8', npm_config_cache: scratch, COREPACK_ENABLE_NETWORK: '0', pnpm_config_verify_deps_before_run: 'false', pnpm_config_pm_on_fail: 'error', npm_config_verify_deps_before_run: 'false', npm_config_manage_package_manager_versions: 'false' };
    return new Promise((resolve, reject) => {
      const child = spawn('/usr/bin/sandbox-exec', ['-p', profile, '/usr/bin/env', `DYLD_INSERT_LIBRARIES=${shim}`, command.executable, ...command.args], { cwd: workspace.path, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const buffers = { stdout: '', stderr: '' };
      let killError: unknown;
      let stopped = false, truncated = false, escalation: ReturnType<typeof setTimeout> | undefined;
      const append = (kind: keyof typeof buffers, data: Buffer) => { const remaining = CODE_WORKSPACE_LIMITS.maxLogBytes - Buffer.byteLength(buffers[kind]); if (data.length > remaining) truncated = true; if (remaining > 0) buffers[kind] += data.subarray(0, remaining).toString('utf8'); };
      const killGroup = (killSignal: NodeJS.Signals) => { if (!child.pid) return; try { process.kill(-child.pid, killSignal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') killError = error; } };
      const stop = () => { if (stopped) return; stopped = true; killGroup('SIGTERM'); escalation = setTimeout(() => killGroup('SIGKILL'), CODE_WORKSPACE_LIMITS.stopTimeoutMs); };
      const timer = setTimeout(stop, CODE_WORKSPACE_LIMITS.checkTimeoutMs);
      signal.addEventListener('abort', stop, { once: true });
      child.stdout.on('data', (data: Buffer) => append('stdout', data)); child.stderr.on('data', (data: Buffer) => append('stderr', data));
      const cleanup = () => { clearTimeout(timer); if (escalation) clearTimeout(escalation); signal.removeEventListener('abort', stop); killGroup('SIGKILL'); };
      child.once('error', (error) => { cleanup(); reject(error); });
      child.once("exit", () => killGroup("SIGKILL"));
      child.once('close', (exitCode) => { cleanup(); void (async () => { if (child.pid) await confirmProcessGroupStopped(child.pid); if (killError) buffers.stderr += `\n[HCode] 进程组信号返回 ${String(killError)}；已通过系统进程状态确认无运行成员。`; resolve({ checkId: check.id, command: [command.executable, ...command.args].join(' '), versionId: version.id, versionHash: version.hash, exitCode, status: stopped ? 'interrupted' : exitCode === 0 ? 'passed' : 'failed', stdout: buffers.stdout, stderr: buffers.stderr, logTruncated: truncated }); })().catch(reject); });
      if (signal.aborted) stop();
    });
  }
}
