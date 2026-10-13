// 独立写任务的准入、基线与人工生命周期；不调度模型、不自动合并或采纳。
import { lstat, realpath } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { CollaborationSnapshot, CollaborationCapabilities, CollaborationStartParams, DeliverySnapshot } from '../../../shared/collaboration.js';
import { assertCandidateScope, candidateForVersion, codeCandidates, deliveryCode } from '../../../shared/codeCandidates.js';
import { adoptionBlocksEdits } from '../../../shared/codeAdoption.js';
import type { CodeWorkspace } from '../../../shared/codeDelivery.js';
import type { WorkspaceService } from './workspaceService.js';
import { inspectCodeProject } from './validationPlan.js';
export class CodeRunService {
  constructor(private readonly workspaces: WorkspaceService) {}
  /** 在派发前冻结共同基线；任何后端未准入或复制期间变化都拒绝启动。 */
  async initialize(snapshot: CollaborationSnapshot, params: CollaborationStartParams, capabilities: CollaborationCapabilities[]) {
    if(!params.code)return;
    const admission=await inspectCodeProject(params.initiator.projectPath);
    if(admission.hash!==params.code.admissionHash)throw new Error('项目已变化，请重新确认验证计划');
    const checks=params.code.checks.map(id=>{const check=admission.checks.find(entry=>entry.id===id);if(!check)throw new Error('检查不属于本次项目配置');return check;});
    for(const task of params.code.tasks??[]){
      if(!capabilities.find(entry=>entry.agent===task.executor.agent)?.canExecuteCode)throw new Error('并行任务执行者未通过代码写入准入');
      await this.assertFiles(params.initiator.projectPath,task.allowedPaths);
    }
    if(!params.code.tasks){
      const workspace=await this.workspaces.create(params.initiator.projectPath,snapshot.id,{...admission,checks});
      snapshot.code={workspace,versions:[],validations:[],phase:'execution'};return;
    }
    const allocated:CodeWorkspace[]=[];
    try{
      for(const task of params.code.tasks){
        const workspace=await this.workspaces.create(params.initiator.projectPath,randomUUID(),{...admission,checks},snapshot.id);
        allocated.push(workspace);
        snapshot.deliveries.push({id:randomUUID(),requestKey:task.requestKey,objective:task.objective,executor:task.executor,status:'queued',versions:[],reviews:[],code:{workspace,allowedPaths:task.allowedPaths,versions:[],validations:[],phase:'execution'}});
      }
    }catch(error){
      try{await this.workspaces.rollbackCreation(snapshot.id,allocated);}
      catch(cleanupError){throw new AggregateError([error,cleanupError],'并行工作区分配和撤回均失败，请核对目录');}
      throw error;
    }
  }
  /** 文件清单逐层核验实际目录；新文件允许不存在，已有目录、链接或大小写别名拒绝。 */
  async assertFiles(root:string,paths:string[]) {
    for(const path of paths){
      const target=join(root,path);
      let current=target;
      while(current!==root){
        let info;
        try{info=await lstat(current);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
        if(info){
          if(info.isSymbolicLink() || await realpath(current)!==current)throw new Error(`文件范围含链接或大小写别名：${path}`);
          if(current===target&&!info.isFile() || current!==target&&!info.isDirectory())throw new Error(`文件范围必须是普通文件，祖先必须是目录：${path}`);
        }
        current=dirname(current);
      }
    }
  }
  preview(snapshot: CollaborationSnapshot, versionId: string) {
    const {code,version}=candidateForVersion(snapshot,z.string().uuid().parse(versionId));
    return this.workspaces.preview(code.workspace,version);
  }
  /** 接管/丢弃只影响所选任务；已采纳结果只能清理副本，恢复所需目录始终保留。 */
  async action(snapshot: CollaborationSnapshot, action: 'manual'|'discard'|'cleanup', deliveryId?:string) {
    const target=deliveryId?codeCandidates(snapshot).find(entry=>entry.deliveryId===z.string().uuid().parse(deliveryId)):snapshot.code?{code:snapshot.code}:undefined;
    if(!target)throw new Error('请选择本次协作的具体代码任务');
    const code=target.code;
    if(code.workspace.state==='discarded')throw new Error('没有可操作的候选工作区');
    if(code.stopUnconfirmed||this.workspaces.isLeased(code.workspace.id))throw new Error('工作区停止尚未确认，租约保持锁定');
    if(action==='cleanup'){
      if(code.adoption?.status!=='applied'||code.adoption.cleanupPending)throw new Error('只清理已采纳且不需要恢复的副本');
    }else if(adoptionBlocksEdits(code.adoption))throw new Error('候选已应用或采纳尚需恢复，不能接管或丢弃');
    const deliveries=deliveryId?snapshot.deliveries.filter(delivery=>delivery.id===deliveryId):snapshot.deliveries;
    if(action==='manual'){
      code.workspace.state='manual';code.phase='manual';snapshot.status='awaitingUser';
      for(const delivery of deliveries){delivery.status='awaitingUser';delivery.error='用户已接管此候选目录，旧通过结论失效；人工编辑后重新验证和审查';}
      delete snapshot.summary;
    }else{
      await this.workspaces.discard(code.workspace);code.phase='discarded';
      if(action==='discard'){
        for(const delivery of deliveries){delivery.status='cancelled';delivery.error='用户已丢弃此任务可写副本，冻结历史仍保留';}
        snapshot.status=snapshot.deliveries.every(delivery=>delivery.status==='cancelled')?'cancelled':'awaitingUser';delete snapshot.summary;
      }
    }
    return code.workspace.path;
  }
  async assertAccepted(snapshot: CollaborationSnapshot, delivery: DeliverySnapshot) {
    const code=deliveryCode(snapshot,delivery);
    if(!code)return;
    const version=code.versions.at(-1);
    if(!version||code.workspace.state!=='candidate')throw new Error('代码候选已接管或丢弃，需要重新验证');
    assertCandidateScope(code,version);
    await this.workspaces.assertCurrent(code.workspace,version);
    if(!code.workspace.admission.checks.length||!code.workspace.admission.checks.every(check=>code.validations.findLast(entry=>entry.versionId===version.id&&entry.checkId===check.id)?.status==='passed'))throw new Error('代码候选没有同版本必需检查通过证据');
  }
}
