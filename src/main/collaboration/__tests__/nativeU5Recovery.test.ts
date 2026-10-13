// 恢复自有原生验收的失败 Run；沿用旧问题、答案、报告、原生会话和累计预算验证修复。
import { cp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, join, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import type { CollaborationSnapshot } from '../../../shared/collaboration.js';
vi.mock('../../util/trash.js', () => ({ trashPaths: async () => { throw new Error('原生验收禁止删除历史'); } }));
import { nativeFixture } from './nativeFixture.js';

it.skipIf(!process.env.HCODE_NATIVE_U5_RECOVERY_RUN || !process.env.HCODE_NATIVE_U5_RECOVERY_ARCHIVE || !process.env.HCODE_NATIVE_EVIDENCE_DIR)('U5 原失败记录收到答案后明确续跑，完成独立审查且不重复其他任务', async () => {
  const id = process.env.HCODE_NATIVE_U5_RECOVERY_RUN!;
  const archive = process.env.HCODE_NATIVE_U5_RECOVERY_ARCHIVE!;
  const previous = JSON.parse(await readFile(join(archive, id, 'run.json'), 'utf8')) as CollaborationSnapshot;
  const root = previous.params.initiator.projectPath;
  const offset = relative(await realpath(tmpdir()), root);
  if (!basename(root).startsWith('hcode-u5-native-') || offset.startsWith('..') || isAbsolute(offset)) throw new Error('仅恢复自有 U5 临时验收目录');
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'source.ts'), 'export const allowed = [0, 42];\n');
  await cp(join(archive, id), join(root, 'records', id), { recursive: true });
  const data = await nativeFixture('hcode-u5-recovery-', undefined, undefined, root);
  try {
    const recovered = await data.service.get(id);
    expect(recovered.status).toBe('awaitingUser');
    expect(data.outcomes).toHaveLength(0);
    const target = recovered.deliveries.find(delivery => delivery.status === 'awaitingUser')!;
    const accepted = recovered.deliveries.find(delivery => delivery.status === 'accepted')!;
    expect(recovered.messages?.some(message => message.type === 'answer' && message.deliveryId === target.id)).toBe(true);
    await data.service.controls.resume(id, { deliveryId: target.id, action: 'execute' });
    await vi.waitFor(() => expect(data.latest()?.stage).toBe('finished'), { timeout: 300_000, interval: 1000 });
    const final = await data.service.get(id);
    expect(final.status, JSON.stringify(final)).toBe('completed');
    expect(final.deliveries.find(delivery => delivery.id === accepted.id)).toEqual(accepted);
    const result = final.deliveries.find(delivery => delivery.id === target.id)!;
    expect(result.versions).toHaveLength(1);
    expect(result.reviews.at(-1)?.verdict).toBe('approved');
    expect(final.messages).toEqual(recovered.messages);
    expect(final.tasks.length).toBeLessThanOrEqual(12);
    expect(final.tasks.slice(recovered.tasks.length).filter(task => task.role === 'execution').every(task => task.deliveryId === target.id)).toBe(true);
    expect(final.tasks.at(-1)?.nativeSessionId).toBe(recovered.params.initiator.resumeSessionId);
    expect(await readFile(join(root, 'source.ts'), 'utf8')).toBe('export const allowed = [0, 42];\n');
    await writeFile(join(process.env.HCODE_NATIVE_EVIDENCE_DIR!, 'recovery-acceptance.json'), JSON.stringify({ runId: id, beforeTurns: recovered.tasks.length, final, otherReportUnchanged: true, sourceUnchanged: true }, null, 2));
  } finally { await data.cleanup(); }
}, 350_000);
