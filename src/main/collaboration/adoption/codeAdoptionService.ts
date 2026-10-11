// 从冻结候选到原项目的用户采纳；权限来自 IPC 用户动作，模型没有采纳工具。
import { assertCandidateScope, codeCandidates } from '../../../shared/codeCandidates.js';
import { lstat, realpath } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { CollaborationSnapshot } from "../../../shared/collaboration.js";
import {
  ADOPTION_LOCK_DIRECTORY,
  type AdoptionPreview,
  type AdoptionRequest,
} from "../../../shared/codeAdoption.js";
import { hashBytes } from "../workspaces/fileManifest.js";
import type { WorkspaceService } from "../workspaces/workspaceService.js";
import type { CollaborationRepository } from "../collaborationRepository.js";
import {
  adoptionRequestSchema,
  type AdoptionJournal,
} from "./adoptionContracts.js";
import { adoptionArtifacts } from "./adoptionArtifacts.js";
import { AdoptionJournalRepository } from "./adoptionJournal.js";
import {
  AdoptionTransaction,
  type AdoptionCheckpoint,
} from "./adoptionTransaction.js";
import { fileState, optionalStat, sameFile } from "./adoptionPaths.js";
export class CodeAdoptionService {
  private readonly journals: AdoptionJournalRepository;
  private readonly transaction: AdoptionTransaction;
  private readonly busy = new Set<string>();
  constructor(
    private readonly workspaces: WorkspaceService,
    private readonly repository: CollaborationRepository,
    checkpoint?: AdoptionCheckpoint,
  ) {
    this.journals = new AdoptionJournalRepository(repository.root);
    this.transaction = new AdoptionTransaction(this.journals, checkpoint);
  }
  /** 读到未终结日志仅展示需要恢复；不写原项目，也不自动重跑。 */
  async decorate(snapshot: CollaborationSnapshot) {
    for(const {code} of codeCandidates(snapshot)){
      const latest=await this.journals.latest(snapshot.id,code.workspace.id,!code.workspace.runId);
      if(latest)code.adoption=structuredClone(latest.state);
    }
    return snapshot;
  }
  private async reasons(snapshot: CollaborationSnapshot, versionId: string) {
    const code = snapshot.code!;
    const version = code.versions.at(-1),
      delivery = snapshot.deliveries[0],
      report = delivery?.versions.at(-1),
      review = delivery?.reviews.at(-1);
    const reasons: string[] = [];
    if (
      snapshot.status !== "completed" ||
      snapshot.stage !== "finished" ||
      code.phase !== "candidate" ||
      code.workspace.state !== "candidate"
    )
      reasons.push("仅采纳已完成且仍处于待采纳状态的交付");
    if (code.stopUnconfirmed || this.workspaces.isLeased(code.workspace.id))
      reasons.push("工作区仍被占用或停止未确认");
    if (!version || version.id !== versionId)
      reasons.push("只能采纳最新通过版本，旧版本不开放应用");
    if (
      snapshot.deliveries.length !== 1 ||
      delivery?.status !== "accepted" ||
      !report ||
      report.version !== version?.version ||
      review?.versionId !== report.id ||
      review.verdict !== "approved" ||
      review.issues.some((issue) => issue.blocking)
    )
      reasons.push("没有同版本独立审查通过证据");
    if (
      !version ||
      !code.workspace.admission.checks.length ||
      !code.workspace.admission.checks.every((check) => {
        const result = code.validations.findLast(
          (entry) =>
            entry.versionId === version.id && entry.checkId === check.id,
        );
        return (
          result?.status === "passed" &&
          result.exitCode === 0 &&
          result.versionHash === version.hash
        );
      })
    )
      reasons.push("没有同版本全部必需检查通过证据");
    if (
      code.adoption &&
      (code.adoption.status !== "rolledBack" || code.adoption.cleanupPending)
    )
      reasons.push(
        code.adoption.status === "applied"
          ? "此交付已应用；不重复写回"
          : "已有采纳日志需要恢复或清理",
      );
    if (
      await optionalStat(
        join(code.workspace.originalPath, ADOPTION_LOCK_DIRECTORY),
      )
    )
      reasons.push("原项目有采纳锁，请先完成已有任务的恢复或清理");
    try {
      if (version) { assertCandidateScope(code,version); await this.workspaces.assertCurrent(code.workspace, version); }
      if (report) await this.repository.readReport(snapshot.id, report);
    } catch (error) {
      reasons.push(String(error));
    }
    return reasons;
  }
  /** 返回所选冻结版本的资格与全部冲突；不写原项目，冻结污染会抛错。 */
  async preview(
    input: CollaborationSnapshot,
    versionId: string,
  ): Promise<AdoptionPreview> {
    const snapshot = await this.decorate(input),
      code = snapshot.code;
    if (!code) throw new Error("此协作不是代码交付");
    const version = code.versions.find(
      (entry) =>
        entry.id === adoptionRequestSchema.shape.versionId.parse(versionId),
    );
    if (!version) throw new Error("候选版本不属于本次协作");
    if (
      (await realpath(code.workspace.originalPath)) !==
      code.workspace.originalPath
    )
      throw new Error("原项目根目录变为链接，不能采纳");
    const preview = await this.workspaces.preview(code.workspace, version);
    const artifacts = await adoptionArtifacts(
      this.workspaces,
      code.workspace,
      version,
    );
    const reasons = await this.reasons(snapshot, versionId),
      conflicts: AdoptionPreview["conflicts"] = [];
    const paths = artifacts.operations.map((op) => op.path);
    if (new Set(paths.map((path) => path.toLowerCase())).size !== paths.length)
      reasons.push("改动路径存在大小写歧义");
    if (
      paths.some((path) => paths.some((other) => path.startsWith(`${other}/`)))
    )
      reasons.push("此切片不支持文件与目录相互转换");
    for (const operation of artifacts.operations) {
      try {
        if (
          !sameFile(
            await fileState(code.workspace.originalPath, operation.path),
            operation.before,
          )
        )
          conflicts.push({
            path: operation.path,
            reason: "原文件内容、权限或存在状态已偏离冻结基线",
          });
      } catch (error) {
        conflicts.push({ path: operation.path, reason: String(error) });
      }
    }
    const hash = hashBytes(
      JSON.stringify({
        runId: snapshot.id,
        version,
        originalPath: code.workspace.originalPath,
        reasons,
        conflicts,
      }),
    );
    return {
      ...preview,
      hash,
      originalPath: code.workspace.originalPath,
      eligible: reasons.length === 0 && conflicts.length === 0,
      reasons,
      conflicts,
      ...(code.adoption ? { adoption: code.adoption } : {}),
    };
  }
  private async exclusive<T>(id: string, action: () => Promise<T>): Promise<T> {
    if (this.busy.has(id)) throw new Error("此交付正在采纳或恢复，请等待结果");
    this.busy.add(id);
    try {
      return await action();
    } finally {
      this.busy.delete(id);
    }
  }
  /** 绑定用户预览后采纳；准入失败抛错，部分应用失败返回可恢复状态。 */
  async apply(snapshot: CollaborationSnapshot, input: AdoptionRequest) {
    const request = adoptionRequestSchema.parse(input);
    return this.exclusive(snapshot.id, async () => {
      const prior = await this.journals.latest(snapshot.id,snapshot.code?.workspace.id,!snapshot.code?.workspace.runId);
      if (
        prior?.state.status === "applied" &&
        prior.state.versionId === request.versionId &&
        prior.state.previewHash === request.previewHash
      )
        return structuredClone(prior.state);
      const preview = await this.preview(snapshot, request.versionId);
      if (!preview.eligible)
        throw new Error(
          [
            ...preview.reasons,
            ...preview.conflicts.map(
              (conflict) => `${conflict.path}：${conflict.reason}`,
            ),
          ].join("\n"),
        );
      if (preview.hash !== request.previewHash)
        throw new Error("预览已变化，请重新核对后确认采纳");
      const code = snapshot.code!;
      if (
        snapshot.status !== "completed" ||
        code.phase !== "candidate" ||
        code.workspace.state !== "candidate"
      )
        throw new Error("候选状态在预览期间变化");
      const release = this.workspaces.acquire(code.workspace.id, "adoption");
      try {
        const artifacts = await adoptionArtifacts(
          this.workspaces,
          code.workspace,
          preview.version,
        );
        const root = await lstat(code.workspace.originalPath),
          now = Date.now();
        const journal: AdoptionJournal = {
          state: {
            id: randomUUID(),
            runId: snapshot.id,
            workspaceId: code.workspace.id,
            versionId: preview.version.id,
            versionHash: preview.version.hash,
            previewHash: preview.hash,
            status: "prepared",
            cleanupPending: false,
            createdAt: now,
            updatedAt: now,
            changedPaths: artifacts.operations.map((op) => op.path),
          },
          originalPath: code.workspace.originalPath,
          rootDevice: root.dev,
          rootInode: root.ino,
          createdDirectories: [],
          operations: artifacts.operations,
        };
        await this.journals.create(journal, artifacts.contents);
        try {
          await this.transaction.apply(journal);
        } catch (error) {
          journal.state.error = String(error);
          if (journal.state.status !== "applied")
            journal.state.status = "needsRecovery";
          await this.journals.save(journal);
        }
        code.adoption = structuredClone(journal.state);
        return structuredClone(journal.state);
      } finally {
        release();
      }
    });
  }
  /** 用户明确恢复时回滚自己的未完成写入；已提交记录只清理，不撤销成功结果。 */
  async recover(snapshot: CollaborationSnapshot, adoptionId: string) {
    return this.exclusive(snapshot.id, async () => {
      if (
        snapshot.code?.stopUnconfirmed ||
        (snapshot.code && this.workspaces.isLeased(snapshot.code.workspace.id))
      )
        throw new Error("候选被占用或停止未确认");
      const journal = await this.journals.load(snapshot.id, adoptionId),
        latest = await this.journals.latest(snapshot.id,snapshot.code?.workspace.id,!snapshot.code?.workspace.runId);
      if (latest?.state.id !== adoptionId)
        throw new Error("只能恢复最新采纳记录");
      if (
        !snapshot.code ||
        journal.originalPath !== snapshot.code.workspace.originalPath || journal.state.workspaceId && journal.state.workspaceId !== snapshot.code.workspace.id
      )
        throw new Error("恢复记录的原项目不一致");
      try {
        if (
          journal.state.status === "applied" ||
          journal.state.status === "rolledBack"
        )
          await this.transaction.cleanup(journal);
        else await this.transaction.rollback(journal);
      } catch (error) {
        journal.state.error = String(error);
        if (!["applied", "rolledBack"].includes(journal.state.status))
          journal.state.status = "needsRecovery";
        await this.journals.save(journal);
      }
      snapshot.code.adoption = structuredClone(journal.state);
      return structuredClone(journal.state);
    });
  }
}
