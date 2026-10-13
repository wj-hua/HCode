// 公开服务在真实仓库恢复候选；接管/丢弃不调用模型，停止未知不能变成人工可写。
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { CollaborationSnapshot } from '../../../shared/collaboration.js';
import { AgentRegistry } from '../../agents/registry.js';
import type { AgentKind } from '../../../shared/types.js';
import type { AgentProvider } from '../../agents/types.js';
import { SessionExecutionService } from '../../sessions/sessionExecutionService.js';
import { CollaborationRepository } from '../collaborationRepository.js';
import { CollaborationService } from '../collaborationService.js';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'hcode-code-recovery-')); roots.push(root);
  const original = join(root, 'original'); await mkdir(original); await writeFile(join(original, 'source.js'), 'old\n');
  const send = vi.fn(async () => { throw new Error('此动作不得启动 CLI'); });
  const execution = new SessionExecutionService({ prepare: async (input) => input, send, interrupt: async () => {}, failedToSend: () => {}, finishedSending: () => {} });
  const repository = new CollaborationRepository(join(root, 'records'));
  const service = new CollaborationService(repository, execution, new AgentRegistry({} as Record<AgentKind, AgentProvider>), () => {});
  const id = randomUUID(), workspace = await service.workspaces.create(original, id);
  await writeFile(join(workspace.path, 'source.js'), 'new\n');
  const version = await service.workspaces.freeze(workspace, 1);
  const snapshot: CollaborationSnapshot = { id, seq: 1, createdAt: Date.now(), status: 'completed', stage: 'finished', summary: '待采纳', tasks: [], deliveries: [{ id: randomUUID(), requestKey: 'code', objective: '代码交付', executor: { agent: 'codex' }, status: 'accepted', versions: [], reviews: [] }], params: { initiator: { agent: 'claude', sessionKey: randomUUID(), projectPath: original, permissionMode: 'default' }, executor: { agent: 'codex' }, objective: '代码交付' }, code: { workspace, versions: [version], validations: [], phase: 'candidate' } };
  await repository.save(snapshot);
  return { service, repository, snapshot, version, original, send };
}
it('重启读取不自动执行，接管使旧通过失效，丢弃保留原项目和冻结预览', async () => {
  const data = await fixture();
  const restored = await data.service.get(data.snapshot.id);
  expect(restored.status).toBe('completed');
  await data.service.workspaces.assertCurrent(restored.code!.workspace, restored.code!.versions[0]!);
  await data.service.candidateAction(data.snapshot.id, 'manual');
  const manual = await data.repository.load(data.snapshot.id);
  expect(manual.status).toBe('awaitingUser'); expect(manual.deliveries[0]!.status).toBe('awaitingUser'); expect(manual.summary).toBeUndefined();
  await data.service.candidateAction(data.snapshot.id, 'discard');
  expect((await data.service.get(data.snapshot.id)).code!.phase).toBe('discarded');
  expect((await data.service.candidatePreview(data.snapshot.id, data.version.id)).changes[0]).toMatchObject({ before: 'old\n', after: 'new\n' });
  expect(await readFile(join(data.original, 'source.js'), 'utf8')).toBe('old\n');
  expect(data.send).not.toHaveBeenCalled();
});
it('验证期间重启保留停止未知锁，拒绝接管、丢弃和续跑', async () => {
  const data = await fixture();
  data.snapshot.seq++; data.snapshot.status = 'running'; data.snapshot.code!.phase = 'validation';
  await data.repository.save(data.snapshot);
  const recovered = await data.service.get(data.snapshot.id);
  expect(recovered.status).toBe('interrupted'); expect(recovered.code!.stopUnconfirmed).toBe(true);
  await expect(data.service.candidateAction(data.snapshot.id, 'manual')).rejects.toThrow(/停止尚未确认/);
  await expect(data.service.candidateAction(data.snapshot.id, 'discard')).rejects.toThrow(/停止尚未确认/);
  await expect(data.service.controls.resume(data.snapshot.id, { action: 'review', deliveryId: data.snapshot.deliveries[0]!.id })).rejects.toThrow(/停止未确认/);
  expect(data.send).not.toHaveBeenCalled();
});
it('暂停后仍有未完成采纳时不能接管原会话，恢复前不启动普通模型', async () => {
  const data = await fixture();
  data.snapshot.seq++; data.snapshot.status = 'paused';
  data.snapshot.code!.adoption = { id: randomUUID(), runId: data.snapshot.id, workspaceId: data.snapshot.code!.workspace.id, versionId: data.version.id, versionHash: data.version.hash, previewHash: 'a'.repeat(64), status: 'needsRecovery', cleanupPending: false, createdAt: Date.now(), updatedAt: Date.now(), changedPaths: ['source.js'] };
  await data.repository.save(data.snapshot);
  await expect(data.service.controls.takeover(data.snapshot.id)).rejects.toThrow('采纳');
  expect(data.send).not.toHaveBeenCalled();
  expect(await readFile(join(data.original, 'source.js'), 'utf8')).toBe('old\n');
});
