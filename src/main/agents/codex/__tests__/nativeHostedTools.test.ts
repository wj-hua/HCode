// 显式启用真实 CLI；先独立验证候选版本的实验协议，再决定生产版本准入。
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { z } from 'zod';
import type { TurnOutcome } from '../../../../shared/collaboration.js';
import { findExecutable } from '../../../util/locateCli.js';
import { AppServerClient, type ServerRequest } from '../appServerClient.js';
import { CodexSession } from '../codexSession.js';

const enabled = process.env.HCODE_NATIVE_CODEX_PROTOCOL === '1';

it.skipIf(!enabled)('真实 Codex 动态工具注册、成功/失败结果与重启后同线程重绑定', async () => {
  const executable = findExecutable('codex', process.env, process.env.HCODE_CODEX_PATH);
  if (!executable) throw new Error('未找到 Codex 验收程序');
  const { stdout } = await promisify(execFile)(executable, ['--version']);
  const root = await mkdtemp(join(tmpdir(), 'hcode-native-hosted-'));
  const requests: ServerRequest[] = [], items: Record<string, unknown>[] = [], outcomes: TurnOutcome[] = [];
  const registrations: unknown[] = [];
  let resolve!: (outcome: TurnOutcome) => void;
  let session!: CodexSession;
  let client!: AppServerClient;
  const calls: string[] = [];
  const success = randomUUID(), failure = randomUUID(), resumed = randomUUID();
  const connect = (threadId?: string) => {
    client = new AppServerClient(async () => ({ path: executable, env: process.env as Record<string, string>, experimentalApi: true }), 'protocol-validation');
    const request = client.request.bind(client);
    client.request = async <T = unknown>(method: string, params?: unknown): Promise<T> => {
      if (method === 'thread/start') registrations.push(params);
      return request<T>(method, params);
    };
    session = new CodexSession({
      client, emitRows: () => {}, emitState: () => {}, emitPermission: () => {}, emitPermissionResolved: () => {},
      onThreadId: () => {}, onTurnCompleted: () => {},
      emitTurnOutcome: outcome => { outcomes.push(outcome); resolve(outcome); },
    }, { key: 'protocol-source', projectPath: root, permissionMode: 'full-access', threadId });
    session.effort = 'low';
    client.on('notification', (method, params) => {
      if (method === 'item/completed' && params.item?.type === 'dynamicToolCall') items.push(params.item);
      session.handleNotification(method, params);
    });
    client.on('request', request => {
      requests.push(request);
      if (!session.handleServerRequest(request)) client.respondError(request.id, '未授权验收工具');
    });
  };
  const configure = async (marker: string) => session.configureHosted({
    root, instructions: '仅做工具协议验收。必须使用 hcode_protocol_probe；不执行命令、不读写文件、不调用其他工具。',
    tools: [{ name: 'protocol_probe', description: '返回宿主生成的随机标记；reject 操作返回实际错误', schema: { action: z.enum(['accept', 'reject']) }, execute: async input => {
      calls.push(String(input.action));
      if (input.action === 'reject') throw new Error(`PROBE_REJECTED_${failure}`);
      return { marker };
    } }],
  });
  const send = async (prompt: string) => {
    const done = new Promise<TurnOutcome>(callback => { resolve = callback; });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('真实 Codex 回合超过 240 秒')), 240_000); });
      const outcome = await Promise.race([(async () => { await session.send(prompt); return done; })(), deadline]);
      expect(outcome.outcome, JSON.stringify(outcome)).toBe('succeeded');
      return outcome;
    } finally { clearTimeout(timer); }
  };
  connect();
  try {
    await configure(success);
    const first = await send('依次实际调用 hcode_protocol_probe：action=accept，然后 action=reject。不要重试。最终回复包含两个实际返回的完整随机标记，包括错误中的标记。');
    expect(registrations).toHaveLength(1);
    expect(registrations[0]).toMatchObject({ dynamicTools: expect.arrayContaining([expect.objectContaining({ type: 'function', name: 'hcode_protocol_probe' })]) });
    expect(calls).toEqual(['accept', 'reject']);
    expect(first.text).toContain(success);
    expect(first.text).toContain(`PROBE_REJECTED_${failure}`);
    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({ tool: 'hcode_protocol_probe', success: true }),
      expect.objectContaining({ tool: 'hcode_protocol_probe', success: false }),
    ]));
    expect(first.nativeSessionId).toBeTruthy();
    console.info('原生工具注册与成功/失败结果已通过，开始验证重启恢复');
    session.close(); client.dispose();
    connect(first.nativeSessionId);
    await configure(resumed);
    const second = await send('继续协议验收：仅实际调用一次 hcode_protocol_probe，action=accept。最终回复本次调用返回的完整随机标记，不复用历史结果。');
    expect(second.nativeSessionId).toBe(first.nativeSessionId);
    expect(second.text).toContain(resumed);
    expect(calls).toEqual(['accept', 'reject', 'accept']);
    expect(registrations).toHaveLength(1);
  } finally {
    session.close(); client.dispose();
    const evidence = process.env.HCODE_NATIVE_CODEX_PROTOCOL_EVIDENCE;
    if (evidence) {
      await mkdir(evidence, { recursive: true });
      await writeFile(join(evidence, 'hosted-tools.json'), JSON.stringify({ version: stdout.trim(), registrations, requests, items, outcomes }, null, 2));
    }
    await rm(root, { recursive: true, force: true });
  }
}, 510_000);
