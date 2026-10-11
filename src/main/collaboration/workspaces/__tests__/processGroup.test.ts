// 外部系统查询失败不能被解释成已停止；只替换 ps IO，不替换停止判断。
import { expect, it, vi } from 'vitest';
vi.mock('node:child_process', () => ({ execFile: (_file: string, _args: string[], _options: unknown, callback: (error: Error) => void) => callback(new Error('ps unavailable')) }));
import { confirmProcessGroupStopped } from '../processGroup.js';
it('系统查询失败保留未确认状态和可观测原因', async () => {
  await expect(confirmProcessGroupStopped(123)).rejects.toThrow(/验证进程停止未确认.*查询失败/);
});
