// 真实双任务澄清→定向资料保存→重建宿主→指定续跑；只通过公开服务，不改写模型产物。
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
vi.mock('../../util/trash.js', () => ({ trashPaths: async () => { throw new Error('原生验收禁止删除历史'); } }));
import { nativeFixture } from './nativeFixture.js';

it.skipIf(process.env.HCODE_NATIVE_U5 !== '1')('U5 真实补资料、保存隔离与双任务指定续跑，重启不自动执行', async () => {
  const data = await nativeFixture('hcode-u5-native-');
  let restarted: Awaited<ReturnType<typeof nativeFixture>> | undefined;
  const source = 'export const allowed = [0, 42];\n';
  try {
    await writeFile(join(data.root, 'source.ts'), source);
    const run = await data.service.start({
      initiator: { agent: 'claude', sessionKey: randomUUID(), projectPath: data.root, permissionMode: 'default', model: 'sonnet' },
      executor: { agent: 'codex' },
      objective: '只读研究，必须先派发两个独立任务再 wait_tasks。任务一 requestKey=decision：source.ts 目前允许0和42，产品是否允许0尚未确定，要求执行者必须先调用宿主 request_context（requiresUser=true）问用户是否允许0，然后结束回合，回复前不能出报告。任务二 requestKey=fact：只读核对 source.ts 这一完整行，报告该源码数组含0和42的事实，附实际完整源码行证据，不判断产品规则。不得合并任务；同一任务只派发一次，澄清交给用户，不代答、不自动续跑。两任务均不运行测试、不联网、不修改文件。',
    });
    await vi.waitFor(() => expect(data.latest()?.stage).toBe('finished'), { timeout: 300_000, interval: 1000 });
    const blocked = await data.service.get(run.id);
    expect(blocked.status).toBe('awaitingUser');
    expect(blocked.deliveries).toHaveLength(2);
    const question = blocked.messages!.find(message => message.type === 'clarification')!;
    const target = blocked.deliveries.find(delivery => delivery.id === question.deliveryId)!;
    const accepted = blocked.deliveries.find(delivery => delivery.id !== target.id)!;
    expect(accepted.status).toBe('accepted');
    expect(target.versions).toHaveLength(0);
    const before = blocked.tasks.length;
    await data.service.controls.reply(run.id, question.id, '用户决定：允许0和42，当前源码符合期望。仍只读核对，不运行测试。');
    await data.service.controls.supplement(run.id, target.id, '验收资料：请通过宿主 read_file 读取 source.ts 的完整第一行，引用实际数组，区分用户决定和源码事实。');
    expect((await data.service.get(run.id)).tasks).toHaveLength(before);
    await writeFile(join(process.env.HCODE_NATIVE_EVIDENCE_DIR!, 'u5-before-restart.json'), JSON.stringify(await data.service.get(run.id), null, 2));
    data.service.dispose(); data.agents.dispose();
    restarted = await nativeFixture('hcode-u5-restart-', undefined, undefined, data.root);
    const recovered = await restarted.service.get(run.id);
    expect(recovered.messages).toHaveLength(3);
    expect(restarted.outcomes).toHaveLength(0);
    expect(restarted.latest()).toBeUndefined();
    await restarted.service.controls.resume(run.id, { deliveryId: target.id, action: 'execute' });
    await vi.waitFor(() => expect(restarted!.latest()?.stage).toBe('finished'), { timeout: 300_000, interval: 1000 });
    const final = await restarted.service.get(run.id);
    expect(final.status, JSON.stringify(final)).toBe('completed');
    expect(final.deliveries.find(delivery => delivery.id === accepted.id)).toEqual(accepted);
    const rerun = final.tasks.slice(before);
    expect(rerun.filter(task => task.role === 'execution').every(task => task.deliveryId === target.id)).toBe(true);
    expect(rerun.filter(task => task.role === 'review').every(task => task.deliveryId === target.id)).toBe(true);
    expect(final.deliveries.find(delivery => delivery.id === target.id)!.reviews.at(-1)?.verdict).toBe('approved');
    expect(final.tasks.at(-1)?.nativeSessionId).toBe(blocked.params.initiator.resumeSessionId);
    expect(await readFile(join(data.root, 'source.ts'), 'utf8')).toBe(source);
    await writeFile(join(process.env.HCODE_NATIVE_EVIDENCE_DIR!, 'u5-native-acceptance.json'), JSON.stringify({ runId: run.id, taskCountBefore: before, recoveredWithoutDispatch: true, final, sourceUnchanged: true }, null, 2));
  } finally { await (restarted ?? data).cleanup(); }
}, 650_000);
