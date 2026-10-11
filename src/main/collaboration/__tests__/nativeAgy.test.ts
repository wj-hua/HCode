// S4 真实 Gemini 研究与审查验收；输入可种入遗漏，原生模型、工具执行和审查结论不替换。
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
vi.mock('../../util/trash.js', () => ({ trashPaths: async () => { throw new Error('S4 验收禁止删除原生历史'); } }));
import { nativeFixture, selectGeminiModel } from './nativeFixture.js';

it.skipIf(process.env.HCODE_NATIVE_AGY_SMOKE !== '1')('S4 真实 Gemini 宿主读取和结构化报告，使用当前模型列表而非静态型号', async () => {
  const data = await nativeFixture('hcode-s4-smoke-', undefined, undefined, undefined, true);
  try {
    const model = await selectGeminiModel(data.agents);
    await writeFile(join(data.root, 'source.ts'), 'export const marker = "HCode-S4-real-host-read";\n');
    const result = await data.execution.execute({ agent: 'agy', sessionKey: randomUUID(), projectPath: data.root, permissionMode: 'read-only', model, text: '通过 mcp_hcode_read_file 实际读取 source.ts。返回 marker 字符串、相对 path 和宿主 hash 的 JSON。没有读取到就明确失败，不猜测、不使用命令或写入。' }, { root: data.root, outputSchema: { type: 'object', properties: { marker: {type:'string'}, path:{type:'string'}, hash:{type:'string'} }, required:['marker','path','hash'], additionalProperties:false } }, AbortSignal.timeout(90_000));
    expect(result.outcome, JSON.stringify(result)).toBe('succeeded');
    expect(result.nativeSessionId).toBeTruthy();
    expect(JSON.parse(result.text)).toMatchObject({ marker:'HCode-S4-real-host-read', path:'source.ts', hash:expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(await readFile(join(data.root, 'source.ts'), 'utf8')).toBe('export const marker = "HCode-S4-real-host-read";\n');
  } finally { await data.cleanup(); }
}, 120_000);

it.skipIf(process.env.HCODE_NATIVE_AGY_LOOP !== '1').each([
  { initiator:'codex' as const, executor:'agy' as const, reviewer:'claude' as const },
  { initiator:'claude' as const, executor:'codex' as const, reviewer:'agy' as const },
])('S4 $initiator 委派 $executor，独立 $reviewer 阻塞审查、原执行者修订、复审及原会话汇总', async ({initiator, executor, reviewer}) => {
  let first = true;
  const data = await nativeFixture('hcode-s4-loop-', (input) => {
    if (input.agent === executor && first) {
      first = false;
      return { ...input, text:'你是只读研究执行者。初稿仅分析 source.ts 的正常正整数除法，不分析正数除零和零除零；后续独立审查会给完整要求。实际使用宿主 read_file（Codex 前缀 hcode_，agy 前缀 mcp_hcode_）读取源码，不运行命令或写文件。按给定 JSON schema 输出，引用完整逐字源码行，局限注明未运行测试。' };
    }
    return input;
  }, undefined, undefined, true);
  try {
    const model = await selectGeminiModel(data.agents);
    const source = 'export function divide(value: number, divisor: number) {\n  return value / divisor;\n}\n';
    await writeFile(join(data.root,'source.ts'), source);
    const start = await data.service.start({ initiator:{agent:initiator,sessionKey:randomUUID(),projectPath:data.root,permissionMode:'default',...(initiator==='claude'?{model:'sonnet'}:{})}, executor:{agent:executor,...(executor==='agy'?{model}:{})}, reviewer:{agent:reviewer,model:reviewer==='agy'?model:'sonnet'}, objective:'只创建一个完整报告任务，不拆分：调研 source.ts 的 divide，报告必须分别覆盖正常除法、正数除以零、零除以零，准确解释 Infinity 和 NaN。缺任一项是阻塞遗漏。引用实际完整源码行，明确未运行测试，不修改文件，不运行命令。' });
    await vi.waitFor(()=>expect(data.latest()?.stage).toBe('finished'),{timeout:480_000,interval:1000});
    const result = await data.service.get(start.id), delivery = result.deliveries[0]!;
    expect(result.status,JSON.stringify(result)).toBe('completed');
    expect(result.deliveries).toHaveLength(1);
    expect(delivery.status).toBe('accepted');
    expect(delivery.versions.length).toBeGreaterThanOrEqual(2);
    expect(delivery.reviews[0]?.verdict).toBe('changesRequested');
    expect(delivery.reviews[0]?.issues.some((issue)=>issue.blocking)).toBe(true);
    expect(delivery.reviews.at(-1)?.verdict).toBe('approved');
    expect(delivery.reviews.every((review)=>review.reviewer?.agent===reviewer)).toBe(true);
    expect(new Set(result.tasks.filter((task)=>task.role==='execution').map((task)=>task.nativeSessionId)).size).toBe(1);
    const reviews=result.tasks.filter((task)=>task.role==='review');
    expect(new Set(reviews.map((task)=>task.nativeSessionId)).size).toBe(reviews.length);
    const parents=result.tasks.filter((task)=>task.role==='planning'||task.role==='synthesis');
    expect(new Set(parents.map((task)=>task.nativeSessionId)).size).toBe(1);
    expect(result.tasks.every((task)=>task.status==='succeeded'&&task.nativeSessionId)).toBe(true);
    expect(result.tasks.filter((task)=>task.agent==='agy').every((task)=>task.model===model)).toBe(true);
    expect((await data.service.artifact(start.id,delivery.versions.at(-1)!.id)).markdown).toMatch(/Infinity|NaN/);
    expect(await readFile(join(data.root,'source.ts'),'utf8')).toBe(source);
    expect((await data.repository.load(start.id)).summary).toBeTruthy();
  } finally { await data.cleanup(); }
}, 540_000);

it.skipIf(process.env.HCODE_NATIVE_AGY_CONTROL !== '1')('S4 真实 agy 启动期间取消，等待 CLI 退出后确认且不发送用户任务', async () => {
  const data=await nativeFixture('hcode-s4-cancel-',undefined,undefined,undefined,true);
  const key=randomUUID(),abort=new AbortController();
  try {
    const model=await selectGeminiModel(data.agents);
    const pending=data.execution.execute({agent:'agy',sessionKey:key,projectPath:data.root,permissionMode:'read-only',model,text:'启动取消验收：只回复 marker，不读取文件或执行工具。'},{root:data.root},abort.signal);
    await vi.waitFor(()=>expect(data.agents.get('agy').hasSession(key)).toBe(true));
    abort.abort();
    const result=await pending;
    expect(result.outcome,JSON.stringify(result)).toBe('cancelled');
    expect(result.nativeSessionId).toBeTruthy();
    expect(result.text).toBe('');
    expect(()=>data.execution.assertIdle(key)).not.toThrow();
  }finally{await data.cleanup();}
},90_000);
