// HTTP/MCP 公开边界验证真实宿主读取、认证、作用域与工具权限，不替换研究规则。
import { mkdtemp, writeFile, rm, realpath, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { AgyResearchBridge } from '../agyResearchBridge.js';
import { ScopedFileWriter } from '../../../sessions/scopedFileWriter.js';

it('MCP 只返回本项目真实证据，越界、写入、额外参数、未认证及已结束作用域拒绝', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hcode-agy-mcp-')), bridge = new AgyResearchBridge();
  try {
    await writeFile(join(root, 'source.ts'), 'export const answer = 42;\n');
    bridge.begin({ root }); await bridge.listen();
    let id = 0;
    const invoke = async (name: string, args: Record<string, unknown>) => {
      const response = await fetch(bridge.config.serverUrl, { method: 'POST', headers: { ...bridge.config.headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }) });
      return await response.json() as { result?: { content: {text: string}[]; isError?: boolean }; error?: {message: string} };
    };
    const read = await invoke('read_file', { path: 'source.ts' });
    expect(JSON.parse(read.result!.content[0]!.text)).toMatchObject({ path: 'source.ts', content: 'export const answer = 42;\n', hash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect((await invoke('read_file', { path: '../outside' })).result!.isError).toBe(true);
    expect((await invoke('write_file', { path: 'source.ts', content: 'wrong' })).result!.isError).toBe(true);
    expect((await invoke('read_file', { path: 'source.ts', runId: 'another-run' })).result!.isError).toBe(true);
    expect((await fetch(bridge.config.serverUrl, { method: 'POST', body: '{}' })).status).toBe(401);
    bridge.stop(); expect((await invoke('read_file', { path: 'source.ts' })).error!.message).toContain('已结束');
    expect(() => bridge.begin({ root, tools: [{name:'delegate_task',description:'not authorized',schema:{},execute:async()=>null}] })).toThrow('未开放');
  } finally { bridge.close(); await rm(root, { recursive: true, force: true }); }
});

it('重复请求共用一次真实宿主调用；参数顺序不造成冲突，取消后拒绝迟到结果', async () => {
  const bridge=new AgyResearchBridge(); let calls=0, finish:()=>void=()=>{};
  const waiting=new Promise<void>(resolve=>{finish=resolve;});
  try {
    bridge.begin({root:tmpdir(),tools:[{name:'request_context',description:'Authorized task question',schema:{},execute:async()=>{calls++;await waiting;return {asked:true};}}]});await bridge.listen();
    const body={jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'request_context',arguments:{}}};
    const send=async(value:unknown)=>{const response=await fetch(bridge.config.serverUrl,{method:'POST',headers:{...bridge.config.headers,'Content-Type':'application/json'},body:JSON.stringify(value)});return await response.json() as {result:{isError?:boolean}};};
    const first=send(body),duplicate=send({...body,params:{arguments:{},name:'request_context'}});
    await vi.waitFor(()=>expect(calls).toBe(1));
    bridge.stop();finish();
    expect((await first).result.isError).toBe(true);expect((await duplicate).result.isError).toBe(true);expect(calls).toBe(1);
  }finally{finish();bridge.close();}
});

it('研究桥接受宿主只读 Skill 资源工具，仍拒绝委派和写入工具',async()=>{
 const bridge=new AgyResearchBridge();
 try{
  bridge.begin({root:tmpdir(),tools:[{name:'read_expert_resource',description:'Frozen readonly skill resource',schema:{},execute:async()=>({content:'frozen method'})}]});
  await bridge.listen();
  const response=await fetch(bridge.config.serverUrl,{method:'POST',headers:{...bridge.config.headers,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'read_expert_resource',arguments:{}}})});
  const result=await response.json() as {result:{content:{text:string}[]}};
  expect(JSON.parse(result.result.content[0]!.text)).toEqual({content:'frozen method'});
  expect(()=>bridge.begin({root:tmpdir(),tools:[{name:'write_file',description:'unauthorized',schema:{},execute:async()=>null}]})).toThrow('未开放');
 }finally{bridge.close();}
});

it('只有宿主签发的写入闭包可经 Gemini MCP 修改授权文件，越界与关闭后的请求均拒绝', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'hcode-agy-writer-'))), bridge = new AgyResearchBridge();
  let active = true;
  const feedback: unknown[] = [];
  try {
    const tools = new ScopedFileWriter(root, () => { if (!active) throw new Error('写入租约已结束'); }, ['ui.txt'], async event => { feedback.push(event); }).tools();
    bridge.begin({ root, tools }); await bridge.listen();
    let id = 0;
    const request = async (method: string, params: unknown) => {
      const response = await fetch(bridge.config.serverUrl, { method: 'POST', headers: { ...bridge.config.headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
      return await response.json() as { result: { content: { text: string }[]; isError?: boolean; tools: { name: string; annotations: { readOnlyHint: boolean } }[] } };
    };
    const listing = await request('tools/list', {});
    expect(listing.result.tools.find(tool => tool.name === 'write_file')!.annotations.readOnlyHint).toBe(false);
    const rejected = await request('tools/call', { name: 'write_file', arguments: { path: 'business.txt', expectedHash: null, content: 'wrong' } });
    expect(rejected.result.isError).toBe(true);
    expect(JSON.parse(rejected.result.content[0]!.text)).toMatchObject({ code: 'write_scope_violation', path: 'business.txt' });
    expect(feedback).toHaveLength(1);
    expect((await request('tools/call', { name: 'write_file', arguments: { path: 'ui.txt', expectedHash: null, content: 'allowed' } })).result.isError).toBeUndefined();
    active = false;
    const rejectedLate = await request('tools/call', { name: 'delete_file', arguments: { path: 'ui.txt', expectedHash: null } });
    expect(rejectedLate.result.isError).toBe(true);
    expect(await readFile(join(root, 'ui.txt'), 'utf8')).toBe('allowed');
  } finally { bridge.close(); await rm(root, { recursive: true, force: true }); }
});
