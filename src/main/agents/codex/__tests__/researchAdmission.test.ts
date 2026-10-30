// Provider 公共入口独立核验研究隔离，防止普通协议检测放开新版本后绕过受限任务准入。
import { expect, it, vi } from 'vitest';
import { CodexAgent } from '../codexAgent.js';

it('普通工具兼容不允许未经验证的 Codex 版本直接进入研究运行时', async () => {
  const agent = new CodexAgent({ rows: () => {}, state: () => {}, commands: () => {}, permission: () => {}, permissionResolved: () => {}, indexChanged: () => {}, quotaStale: () => {} }, () => ({}), () => '', 'test');
  vi.spyOn(agent, 'getStatus').mockResolvedValue({ kind: 'codex', found: true, version: '0.165.0' });
  try {
    await expect(agent.send({ agent: 'codex', sessionKey: 'research', projectPath: '/project', permissionMode: 'read-only', text: '只读审核', research: { root: '/project' } })).rejects.toThrow('研究隔离验证');
    expect(agent.hasSession('research')).toBe(false);
  } finally { agent.dispose(); }
});
