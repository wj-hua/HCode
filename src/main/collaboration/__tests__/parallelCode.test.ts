// 通过公开协作接口验证并行、恢复、授权范围与逐任务采纳，文件和检查进程均真实运行。
import { readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { parallelFixture } from './parallelCodeFixture.js';
import { CollaborationService } from '../collaborationService.js';
import { CodeAdoptionService } from '../adoption/codeAdoptionService.js';
import { candidateSnapshot } from '../../../shared/codeCandidates.js';
import { manifest } from '../workspaces/fileManifest.js';
it.skipIf(process.platform !== 'darwin')('并行审查收到当前任务目标和文件范围，整体参考需求不会替代逐任务契约',async()=>{
  const data=await parallelFixture('reviewScope');
  try{
    const admission=await data.service.inspectCodeProject(data.project);
    const run=await data.service.start({initiator:{agent:'codex',sessionKey:data.sourceKey,projectPath:data.project,permissionMode:'default'},executor:{agent:'claude'},objective:'两项独立任务共享整体需求参考',code:{admissionHash:admission.hash,checks:['node-test'],tasks:[{requestKey:'one',objective:'任务一',executor:{agent:'claude'},allowedPaths:['value.mjs']},{requestKey:'two',objective:'任务二',executor:{agent:'codex'},allowedPaths:['other.mjs']}]}});
    await vi.waitFor(()=>expect(data.snapshots.at(-1)?.stage).toBe('finished'),{timeout:15_000});
    const result=await data.service.get(run.id);
    expect(result.status).toBe('completed');
    expect(result.deliveries.map(delivery=>delivery.status)).toEqual(['accepted','accepted']);
    expect(result.tasks.filter(task=>task.role==='execution')).toHaveLength(2);
    expect((await manifest(data.project)).hash).toBe(data.original);
  }finally{data.service.dispose();await rm(data.root,{recursive:true,force:true});}
});

it.skipIf(process.platform !== 'darwin').each(['success','transportFailure','outsideScope','disjoint','unknownStop','needsRecovery','lifecycleRace'])('并行写入隔离、失败任务独立续跑、逐任务采纳与冲突拒绝（%s）', async scenario => {
  const {root,project,original,sourceKey,snapshots,repository,service,execution,agents}=await parallelFixture(scenario);
  try{
    const admission=await service.inspectCodeProject(project);
    const run=await service.start({initiator:{agent:'codex',sessionKey:sourceKey,projectPath:project,permissionMode:'default'},executor:{agent:'claude'},objective:'并行生成两个独立候选',code:{admissionHash:admission.hash,checks:['node-test'],tasks:[{requestKey:'one',objective:'任务一',executor:{agent:'claude'},allowedPaths:['value.mjs']},{requestKey:'two',objective:'任务二',executor:{agent:'codex'},allowedPaths:[scenario==='disjoint'?'other.mjs':'value.mjs']}]}});
    await vi.waitFor(()=>expect(snapshots.at(-1)?.stage).toBe('finished'),{timeout:15_000});
    if(['transportFailure','outsideScope'].includes(scenario)){
      const partial=await service.get(run.id), accepted=partial.deliveries[0]!, pending=partial.deliveries[1]!;
      expect(partial.status).toBe('awaitingUser');expect(accepted.status).toBe('accepted');expect(pending.status).toBe('awaitingUser');
      if(scenario==='outsideScope'){expect(pending.error).toMatch(/授权范围外/);await rm(join(pending.code!.workspace.path,'outside.txt'));}
      const acceptedHash=(await manifest(accepted.code!.workspace.path)).hash, acceptedTasks=partial.tasks.filter(task=>task.deliveryId===accepted.id).length;
      await service.controls.resume(run.id,{deliveryId:pending.id,action:'execute'});
      await vi.waitFor(()=>expect(snapshots.at(-1)?.stage).toBe('finished'),{timeout:15_000});
      const resumed=await service.get(run.id);
      expect(resumed.tasks.filter(task=>task.deliveryId===accepted.id)).toHaveLength(acceptedTasks);
      expect((await manifest(accepted.code!.workspace.path)).hash).toBe(acceptedHash);
      expect(resumed.tasks.filter(task=>task.role==='planning'||task.role==='synthesis').every(task=>task.sessionKey===sourceKey)).toBe(true);
    }
    const result=await service.get(run.id);
    expect(result.status,JSON.stringify(result)).toBe('completed');
    if(scenario==='unknownStop'){
      result.seq++;result.status='running';result.stage='awaitingWorkers';
      result.deliveries[0]!.status='reviewing';result.deliveries[0]!.code!.phase='validation';
      result.tasks.find(task=>task.deliveryId===result.deliveries[0]!.id)!.status='running';
      await repository.save(result);
      const restarted=new CollaborationService(repository,execution,agents,()=>{});
      const recovered=await restarted.get(run.id);
      expect(recovered.status).toBe('interrupted');expect(recovered.deliveries[0]!.code!.stopUnconfirmed).toBe(true);expect(recovered.deliveries[1]!.code!.stopUnconfirmed).toBeUndefined();
      await expect(restarted.candidateAction(run.id,'manual',recovered.deliveries[0]!.id)).rejects.toThrow(/停止尚未确认/);
      await restarted.candidateAction(run.id,'manual',recovered.deliveries[1]!.id);
      expect((await restarted.get(run.id)).deliveries[0]!.code!.workspace.state).toBe('candidate');
      expect((await manifest(project)).hash).toBe(original);
      return;
    }
    expect(snapshots.some(snapshot=>snapshot.tasks.filter(task=>task.role==='execution'&&task.status==='running').length===2)).toBe(true);
    expect(result.deliveries).toHaveLength(2);
    const [first,second]=result.deliveries;
    expect(first!.code!.workspace.path).not.toBe(second!.code!.workspace.path);
    expect(first!.code!.workspace.baselineHash).toBe(second!.code!.workspace.baselineHash);
    expect(await readFile(join(first!.code!.workspace.path,'value.mjs'),'utf8')).toContain('= 1');
    expect(await readFile(join(second!.code!.workspace.path,scenario==='disjoint'?'other.mjs':'value.mjs'),'utf8')).toContain('= 2');
    expect((await manifest(project)).hash).toBe(original);
    const secondVersion=second!.code!.versions.at(-1)!, firstVersion=first!.code!.versions.at(-1)!;
    if(scenario==='needsRecovery'){
      const target=candidateSnapshot(result,{deliveryId:first!.id,code:first!.code!});
      const failing=new CodeAdoptionService(service.workspaces,repository,async phase=>{if(phase==='afterFile')throw new Error('受控文件系统中断');});
      const preview=await failing.preview(target,firstVersion.id);
      const pending=await failing.apply(target,{versionId:firstVersion.id,previewHash:preview.hash});
      expect(pending.status).toBe('needsRecovery');
      result.seq++;await repository.save(result);
      const restarted=new CollaborationService(repository,execution,agents,snapshot=>snapshots.push(snapshot));
      let resumeError:unknown;
      try{await restarted.controls.resume(run.id,{deliveryId:second!.id,action:'review'});await vi.waitFor(()=>expect(snapshots.at(-1)?.stage).toBe('finished'),{timeout:15_000});await restarted.get(run.id);}catch(error){resumeError=error;}
      expect(String(resumeError)).toMatch(/先恢复/);
      expect((await restarted.get(run.id)).deliveries[1]!.code!.adoption).toBeUndefined();
      expect((await restarted.recoverAdoption(run.id,pending.id)).status).toBe('rolledBack');
      expect((await manifest(project)).hash).toBe(original);
      await restarted.controls.resume(run.id,{deliveryId:second!.id,action:'review'});
      await vi.waitFor(()=>expect(snapshots.at(-1)?.stage).toBe('finished'),{timeout:15_000});
      expect((await restarted.get(run.id)).status).toBe('completed');return;
    }
    expect((await service.adoptionPreview(run.id,secondVersion.id)).eligible).toBe(true);
    const ready=await service.adoptionPreview(run.id,firstVersion.id);
    expect(ready.eligible,JSON.stringify(ready)).toBe(true);
    const applying=service.applyCandidate(run.id,{versionId:firstVersion.id,previewHash:ready.hash});
    if(scenario==='lifecycleRace')await expect(service.controls.resume(run.id,{deliveryId:second!.id,action:'execute'})).rejects.toThrow(/正在采纳/);
    expect((await applying).status).toBe('applied');
    const conflict=await service.adoptionPreview(run.id,secondVersion.id);
    if(scenario==='disjoint'){
      expect(conflict.eligible).toBe(true);
      expect((await service.applyCandidate(run.id,{versionId:secondVersion.id,previewHash:conflict.hash})).status).toBe('applied');
      expect((await service.applyCandidate(run.id,{versionId:firstVersion.id,previewHash:ready.hash})).versionId).toBe(firstVersion.id);
    }else{
      expect(conflict.conflicts.map(entry=>entry.path)).toEqual(['value.mjs']);
      await expect(service.applyCandidate(run.id,{versionId:secondVersion.id,previewHash:conflict.hash})).rejects.toThrow(/偏离/);
    }
    const recovered=new CollaborationService(repository,execution,agents,()=>{});
    const saved=await recovered.get(run.id);
    expect(saved.deliveries[0]!.code!.adoption?.status).toBe('applied');
    if(scenario==='disjoint')expect(saved.deliveries[1]!.code!.adoption?.status).toBe('applied');
    else expect(saved.deliveries[1]!.code!.adoption).toBeUndefined();
    await recovered.candidateAction(run.id,'cleanup',first!.id);
    expect((await recovered.candidatePreview(run.id,firstVersion.id)).changes[0]!.after).toContain('= 1');
    await recovered.candidateAction(run.id,scenario==='disjoint'?'cleanup':'discard',second!.id);
    expect((await recovered.get(run.id)).deliveries[0]!.code!.adoption?.status).toBe('applied');
    expect(await readFile(join(project,'value.mjs'),'utf8')).toContain('= 1');
  }finally{service.dispose();await rm(root,{recursive:true,force:true});}
});

it.skipIf(process.platform !== 'darwin').each(['pause','cancel','cancelDelivery'] as const)('续跑核验期间拒绝竞争的生命周期动作（%s）',async operation=>{
  const data=await parallelFixture('success');
  try{
    const admission=await data.service.inspectCodeProject(data.project);
    const run=await data.service.start({initiator:{agent:'codex',sessionKey:data.sourceKey,projectPath:data.project,permissionMode:'default'},executor:{agent:'claude'},objective:'并行协作',code:{admissionHash:admission.hash,checks:['node-test'],tasks:[{requestKey:'one',objective:'任务一',executor:{agent:'claude'},allowedPaths:['value.mjs']},{requestKey:'two',objective:'任务二',executor:{agent:'codex'},allowedPaths:['value.mjs']}]}});
    await vi.waitFor(()=>expect(data.snapshots.at(-1)?.stage).toBe('finished'),{timeout:15_000});
    const delivery=(await data.service.get(run.id)).deliveries[0]!;
    await data.service.candidateAction(run.id,'manual',delivery.id);
    const resuming=data.service.controls.resume(run.id,{deliveryId:delivery.id,action:'execute'});
    const competing=operation==='cancelDelivery'?data.service.controls.cancelDelivery(run.id,delivery.id):data.service.controls.stop(run.id,operation);
    const settled=await Promise.allSettled([resuming,competing]);
    await vi.waitFor(()=>expect(data.snapshots.at(-1)?.stage).toBe('finished'),{timeout:15_000});
    const final=await data.service.get(run.id);
    expect(settled[1].status).toBe('rejected');
    if(settled[1].status==='rejected')expect(String(settled[1].reason)).toMatch(/改变候选状态/);
    expect(settled[0].status).toBe('fulfilled');expect(final.status).toBe('completed');
  }finally{data.service.dispose();await rm(data.root,{recursive:true,force:true});}
});

it.skipIf(process.platform !== 'darwin')('无效任务键或文件范围在启动模型前拒绝，未生成假运行记录',async()=>{
  const data=await parallelFixture('success');
  try{
    const admission=await data.service.inspectCodeProject(data.project);
    await mkdir(join(data.project,'src'));
    const base={initiator:{agent:'codex' as const,sessionKey:data.sourceKey,projectPath:data.project,permissionMode:'default' as const},executor:{agent:'claude' as const},objective:'确认范围'};
    const task={requestKey:'one',objective:'任务一',executor:{agent:'claude' as const},allowedPaths:['value.mjs']};
    for(const paths of [['/etc/passwd'],['../value.mjs'],['node_modules/pkg/index.js'],['value.mjs','VALUE.mjs'],['src/*.mjs'],['src'],['VALUE.mjs'],[]]){
      await expect(data.service.start({...base,code:{admissionHash:admission.hash,checks:['node-test'],tasks:[{...task,allowedPaths:paths},{...task,requestKey:'two'}]}})).rejects.toThrow();
    }
    await expect(data.service.start({...base,code:{admissionHash:admission.hash,checks:['node-test'],tasks:[task,task]}})).rejects.toThrow(/任务键重复/);
    expect(data.sends()).toBe(0);expect((await data.repository.catalog()).snapshots).toHaveLength(0);
  }finally{data.service.dispose();await rm(data.root,{recursive:true,force:true});}
});
