// 在文件系统边界注入第二份副本复制失败；分配撤回、源会话释放与重试走真实服务。
import { realpath, rm } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
const failure=vi.hoisted(()=>({source:'',copies:0}));
vi.mock('node:fs/promises',async importOriginal=>{
  const actual=await importOriginal<typeof import('node:fs/promises')>();
  return {...actual,cp:async(...args:Parameters<typeof actual.cp>)=>{
    if(String(args[0])===failure.source && ++failure.copies===2)throw Object.assign(new Error('第二工作区复制失败'),{code:'EIO'});
    return actual.cp(...args);
  }};
});
import { parallelFixture } from './parallelCodeFixture.js';
it.skipIf(process.platform!=='darwin')('第二副本复制失败撤回全部未派发目录，释放源会话且允许重新启动',async()=>{
  const data=await parallelFixture('success');
  try{
    const admission=await data.service.inspectCodeProject(data.project);
    const params={initiator:{agent:'codex' as const,sessionKey:data.sourceKey,projectPath:data.project,permissionMode:'default' as const},executor:{agent:'claude' as const},objective:'并行代码任务',code:{admissionHash:admission.hash,checks:['node-test' as const],tasks:[{requestKey:'one',objective:'任务一',executor:{agent:'claude' as const},allowedPaths:['value.mjs']},{requestKey:'two',objective:'任务二',executor:{agent:'codex' as const},allowedPaths:['value.mjs']}]}};
    // macOS 临时目录存在 /var -> /private/var 别名；故障应注入实际复制入口。
    failure.source=await realpath(data.project);
    await expect(data.service.start(params)).rejects.toThrow('第二工作区复制失败');
    expect(data.sends()).toBe(0);expect(await data.repository.catalog()).toEqual({snapshots:[],issues:[]});
    failure.source='';
    const run=await data.service.start(params);
    await vi.waitFor(()=>expect(data.snapshots.at(-1)?.stage).toBe('finished'),{timeout:15_000});
    expect((await data.service.get(run.id)).status).toBe('completed');
  }finally{data.service.dispose();await rm(data.root,{recursive:true,force:true});}
});
