// 独立目录的快照、独占租约、受控文本写入和候选冻结；写回由独立采纳模块负责。
import { cp, rmdir, lstat, readlink, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { CodeAdmission, CodeVersion, CodeWorkspace, CandidatePreview } from '../../../shared/codeDelivery.js';
import { readResearchFile } from "../../sessions/researchRuntime.js";
import type { HostedTool } from '../../sessions/researchRuntime.js';
import { hashBytes, inside, manifest, type FileManifest } from './fileManifest.js';
import { candidateChanges } from './candidateChanges.js';
import { ScopedFileWriter } from '../../sessions/scopedFileWriter.js';

export class WorkspaceService {
  private readonly leases = new Map<string, string>();
  constructor(private readonly storage: string) {}
  directory(id: string, runId?: string) { const key=z.string().min(1).regex(/^[a-zA-Z0-9-]+$/).parse(id); return runId ? join(this.storage,z.string().uuid().parse(runId),'workspace',key) : join(this.storage,key,'workspace'); }

  /** 完整复制当前上下文；双端清单核对阻止复制中原目录变化及外部链接。 */
  async create(source: string, id: string, admission?: CodeAdmission, runId?: string): Promise<CodeWorkspace> {
    const originalPath = await realpath(source), directory = this.directory(id,runId);
    if (inside(originalPath, resolve(directory))) throw new Error('工作区存储不能位于原项目内部');
    const before = await manifest(originalPath);
    if (admission && admission.hash !== before.hash) throw new Error('项目已变化，请重新确认工作区与验证计划');
    await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
    await mkdir(directory, { mode: 0o700 });
    try {
    const destination = join(directory, 'project');
    await cp(originalPath, destination, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false, filter: (entry) => entry.split('/').at(-1) !== '.git' });
    const path = await realpath(destination);
    const copied = await manifest(path);
    if (copied.hash !== before.hash || (await manifest(originalPath)).hash !== before.hash) throw new Error('项目在复制期间变化，未通过隔离准入');
    await writeFile(join(directory, 'baseline.json'), JSON.stringify(before), { flag: 'wx', mode: 0o600 });
    await cp(path, join(directory, 'baseline'), { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
    return { id, ...(runId?{runId}:{}), path, originalPath, baselineHash: before.hash, admission: admission ?? { hash: before.hash, fileCount: before.entries.length, bytes: before.bytes, checks: [], gitStatus: '', sourceRevision: '', strategy: 'full-copy' }, state: 'candidate' };
    }catch(error){
      try{await rm(directory,{recursive:true});if(!runId)await this.emptyDirectory(dirname(directory));}
      catch(cleanupError){throw new AggregateError([error,cleanupError],'工作区创建和清理均失败，请核对隔离目录');}
      throw error;
    }
  }

  /** 只撤回尚未派发/持久化的本次分配；非空父目录不删除，异常向启动入口传播。 */
  async rollbackCreation(runId:string,allocated:CodeWorkspace[]) {
    for(const workspace of allocated){
      if(workspace.runId!==runId||this.isLeased(workspace.id))throw new Error('不能清理其他 Run 或活动工作区');
      await rm(this.directory(workspace.id,runId),{recursive:true});
    }
    const root=join(this.storage,z.string().uuid().parse(runId));
    await this.emptyDirectory(join(root,'workspace'));
    await this.emptyDirectory(root);
  }
  private async emptyDirectory(path:string) {
    try{await rmdir(path);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  }

  /** 租约由宿主持有；原生停止未知时调用方不得释放执行租约。 */
  acquire(id: string, owner: string) {
    if (this.leases.has(id)) throw new Error('工作区租约被执行、验证或审查占用');
    this.leases.set(id, owner);
    return () => { if (this.leases.get(id) === owner) this.leases.delete(id); };
  }
  isLeased(id: string) { return this.leases.has(id); }
  private assertLease(workspace: CodeWorkspace, owner: string) {
    if (workspace.state === 'discarded' || this.leases.get(workspace.id) !== owner) throw new Error('没有当前工作区写入租约');
  }
  async fileHash(workspace: CodeWorkspace, path: string): Promise<string | null> {
    return new ScopedFileWriter(workspace.path, () => {}).fileHash(path);
  }
  writerTools(workspace: CodeWorkspace, owner: string, allowedPaths?: string[]): HostedTool[] {
    // 保留已有线程的工具目录描述；路径和 hash 规则与普通并行委派共用同一写入边界。
    return new ScopedFileWriter(workspace.path, () => this.assertLease(workspace, owner), allowedPaths).tools().map(tool => {
      tool.description = tool.name === 'write_file'
        ? '在独立候选目录写入完整文本。expectedHash 来自 read_file；新文件为 null。不可写原项目、依赖或符号链接。'
        : '删除候选目录内单个文本文件，必须匹配当前 hash；不支持递归目录删除。';
      return tool;
    });
  }

  /** 每次冻结保留累计差异及完整清单；二进制与权限变化不被文本预览遗漏。 */
  async freeze(workspace: CodeWorkspace, version: number): Promise<CodeVersion> {
    const current = await manifest(workspace.path);
    const baseline: FileManifest = JSON.parse(await readFile(join(this.directory(workspace.id,workspace.runId), 'baseline.json'), 'utf8'));
    if (hashBytes(JSON.stringify(baseline.entries)) !== workspace.baselineHash) throw new Error('候选基线清单已变化');
    const changes = candidateChanges(baseline, current);
    const result: CodeVersion = { id: randomUUID(), version, hash: current.hash, changes };
    const frozen = join(this.directory(workspace.id,workspace.runId), result.id);
    await mkdir(frozen, { mode: 0o700 });
    for (const change of changes.filter((entry) => entry.afterHash)) { const target = join(frozen, 'files', change.path); await mkdir(resolve(target, '..'), { recursive: true }); await cp(join(workspace.path, change.path), target, { verbatimSymlinks: true }); }
    await writeFile(join(frozen, 'manifest.json'), JSON.stringify(current), { flag: 'wx', mode: 0o600 });
    await writeFile(join(frozen, 'version.json'), JSON.stringify(result), { flag: 'wx', mode: 0o600 });
    await this.assertCurrent(workspace, result);
    return result;
  }
  reviewTools(workspace: CodeWorkspace): HostedTool[] {
    return [{ name: "read_baseline_file", description: "只读核对冻结原始基线，检查测试是否被删除或削弱；该工具不能读取原目录或写入任何文件。", schema: { path: z.string().min(1) }, execute: (input) => readResearchFile(join(this.directory(workspace.id,workspace.runId), "baseline"), String(input.path)) }];
  }
  async assertCurrent(workspace: CodeWorkspace, version: CodeVersion) {
    if (workspace.state === 'discarded' || (await manifest(workspace.path)).hash !== version.hash) throw new Error('候选文件已变化，检查与审查结论失效');
    const stored = JSON.parse(await readFile(join(this.directory(workspace.id,workspace.runId), version.id, 'version.json'), 'utf8'));
    // 落盘 schema 恢复会调整字段顺序；比较结构和值，不能把顺序当作代码变化。
    if (!isDeepStrictEqual(stored, version)) throw new Error('冻结版本记录已变化');
  }
  async preview(workspace: CodeWorkspace, version: CodeVersion): Promise<CandidatePreview> {
    const changes = [];
    for (const change of version.changes) {
      for (const [hash, path] of [[change.beforeHash, join(this.directory(workspace.id,workspace.runId), 'baseline', change.path)], [change.afterHash, join(this.directory(workspace.id,workspace.runId), version.id, 'files', change.path)]]) {
        if (!hash) continue;
        const info = await lstat(path!);
        const bytes = info.isSymbolicLink() ? await readlink(path!) : await readFile(path!);
        if (hashBytes(bytes) !== hash) throw new Error('冻结差异文件已变化');
      }
      const before = change.beforeHash && !change.binary ? await readFile(join(this.directory(workspace.id,workspace.runId), 'baseline', change.path), 'utf8') : null;
      const after = change.afterHash && !change.binary ? await readFile(join(this.directory(workspace.id,workspace.runId), version.id, 'files', change.path), 'utf8') : null;
      if (before !== null && hashBytes(before) !== change.beforeHash || after !== null && hashBytes(after) !== change.afterHash) throw new Error('冻结差异文件已变化');
      changes.push({ path: change.path, before, after, binary: change.binary });
    }
    return { version, changes };
  }
  async discard(workspace: CodeWorkspace) {
    if (this.isLeased(workspace.id)) throw new Error('等待原生停止确认与工作区租约释放后才能丢弃');
    await rm(workspace.path, { recursive: true }); workspace.state = 'discarded';
  }
}
