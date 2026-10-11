// 逐文件先移走并核对原件，再用排他 hard-link 安装；失败保留完整日志，只做显式恢复。
import {
  mkdir,
  rename,
  link,
  readdir,
  unlink,
  rmdir,
  readFile,
} from "node:fs/promises";
import { join, dirname } from "node:path";
import { ADOPTION_LOCK_DIRECTORY } from "../../../shared/codeAdoption.js";
import {
  AdoptionJournalRepository,
  durableFile,
  syncDirectory,
} from "./adoptionJournal.js";
import type { AdoptionJournal } from "./adoptionContracts.js";
import {
  assertOriginalRoot,
  guardedTarget,
  optionalStat,
  fileState,
  sameFile,
  parentPaths,
} from "./adoptionPaths.js";
export type AdoptionCheckpoint = (
  stage: "prepared" | "beforeFile" | "afterFile" | "beforeCommit",
  journal: AdoptionJournal,
  index?: number,
) => Promise<void>;
export class AdoptionTransaction {
  constructor(
    private readonly repository: AdoptionJournalRepository,
    private readonly checkpoint?: AdoptionCheckpoint,
  ) {}
  private lock(journal: AdoptionJournal) {
    return join(journal.originalPath, ADOPTION_LOCK_DIRECTORY);
  }
  private async ownedLock(journal: AdoptionJournal) {
    const path = this.lock(journal),
      info = await optionalStat(path);
    if (!info) return false;
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("采纳锁目录类型变化");
    let owner;
    try {
      owner = JSON.parse(await readFile(join(path, "owner.json"), "utf8"));
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code === "ENOENT" &&
        journal.state.cleanupPending &&
        ["applied", "rolledBack"].includes(journal.state.status) &&
        (await readdir(path)).length === 0
      )
        return true;
      throw error;
    }
    if (owner.id !== journal.state.id || owner.runId !== journal.state.runId)
      throw new Error("原项目被另一采纳任务锁定");
    return true;
  }
  /** 所有持久化准备先完成，之后才开始替换原项目文件。 */
  async apply(journal: AdoptionJournal) {
    await assertOriginalRoot(journal);
    const lock = this.lock(journal);
    await mkdir(lock, { mode: 0o700 });
    await durableFile(
      join(lock, "owner.json"),
      JSON.stringify({ id: journal.state.id, runId: journal.state.runId }),
    );
    await syncDirectory(journal.originalPath);
    for (const [index, operation] of journal.operations.entries()) {
      if (operation.after)
        await durableFile(
          join(lock, `${index}-after`),
          await this.repository.content(journal, index, "after"),
          operation.after.mode,
        );
    }
    await syncDirectory(lock);
    await this.checkpoint?.("prepared", journal);
    await assertOriginalRoot(journal);
    for (const operation of journal.operations) {
      if (
        !sameFile(
          await fileState(journal.originalPath, operation.path),
          operation.before,
        )
      )
        throw new Error(`准备后文件发生变化：${operation.path}`);
    }
    journal.state.status = "applying";
    await this.repository.save(journal);
    for (const [index, operation] of journal.operations.entries()) {
      await this.checkpoint?.("beforeFile", journal, index);
      await this.install(journal, index);
      await this.checkpoint?.("afterFile", journal, index);
    }
    await this.checkpoint?.("beforeCommit", journal);
    await assertOriginalRoot(journal);
    for (const operation of journal.operations) {
      if (
        !sameFile(
          await fileState(journal.originalPath, operation.path),
          operation.after,
        )
      )
        throw new Error(`应用后文件发生变化：${operation.path}`);
    }
    journal.state.status = "applied";
    journal.state.cleanupPending = true;
    await this.repository.save(journal);
    await this.cleanup(journal);
  }
  private async createParents(journal: AdoptionJournal, path: string) {
    for (const parent of parentPaths(path)) {
      const target = await guardedTarget(journal.originalPath, parent),
        info = await optionalStat(target);
      if (info) {
        if (!info.isDirectory() || info.isSymbolicLink())
          throw new Error(`目标祖先不是普通目录：${parent}`);
        continue;
      }
      // 创建意图先落盘；恢复只删除仍为空的目录，绝不递归删除。
      if (!journal.createdDirectories.some((entry) => entry.path === parent)) {
        journal.createdDirectories.push({ path: parent });
        await this.repository.save(journal);
      }
      await mkdir(target, { mode: 0o755 });
      const created = await optionalStat(target),
        record = journal.createdDirectories.find(
          (entry) => entry.path === parent,
        )!;
      if (!created?.isDirectory() || created.isSymbolicLink())
        throw new Error(`新建目录已变化：${parent}`);
      record.device = created.dev;
      record.inode = created.ino;
      await this.repository.save(journal);
      await syncDirectory(dirname(target));
    }
  }
  private async install(journal: AdoptionJournal, index: number) {
    const operation = journal.operations[index]!,
      lock = this.lock(journal);
    await assertOriginalRoot(journal);
    await this.ownedLock(journal);
    const target = await guardedTarget(journal.originalPath, operation.path);
    if (
      !sameFile(
        await fileState(journal.originalPath, operation.path),
        operation.before,
      )
    )
      throw new Error(`文件在应用前变化：${operation.path}`);
    operation.started = true;
    await this.repository.save(journal);
    if (operation.after) await this.createParents(journal, operation.path);
    if (operation.before) {
      await rename(target, join(lock, `${index}-captured`));
      await syncDirectory(dirname(target));
      await syncDirectory(lock);
      if (
        !sameFile(await fileState(lock, `${index}-captured`), operation.before)
      )
        throw new Error(`原件移出时变化，保留原件待恢复：${operation.path}`);
    }
    await assertOriginalRoot(journal);
    await guardedTarget(journal.originalPath, operation.path);
    if (operation.after) {
      await link(join(lock, `${index}-after`), target);
      await syncDirectory(dirname(target));
    }
  }
  /** 只恢复属于此应用的文件；未知内容和后续用户修改阻止恢复，不强行覆盖。 */
  async rollback(journal: AdoptionJournal) {
    await assertOriginalRoot(journal);
    if (!(await this.ownedLock(journal))) {
      if (journal.operations.some((op) => op.started))
        throw new Error("应用锁与原件缺失，需人工核对恢复记录");
    } else {
      for (let index = journal.operations.length - 1; index >= 0; index--)
        await this.restore(journal, index);
      for (const parent of [...journal.createdDirectories].reverse()) {
        const target = await guardedTarget(journal.originalPath, parent.path),
          info = await optionalStat(target);
        if (!info) continue;
        if (
          parent.device === undefined ||
          parent.inode === undefined ||
          !info.isDirectory() ||
          info.isSymbolicLink() ||
          info.dev !== parent.device ||
          info.ino !== parent.inode
        )
          throw new Error(`自建目录身份变化，保留待人工核对：${parent.path}`);
        try {
          await rmdir(target);
          await syncDirectory(dirname(target));
        } catch (error) {
          if (
            !["ENOENT", "ENOTEMPTY"].includes(
              (error as NodeJS.ErrnoException).code ?? "",
            )
          )
            throw error;
        }
      }
    }
    journal.state.status = "rolledBack";
    journal.state.cleanupPending = true;
    delete journal.state.error;
    await this.repository.save(journal);
    await this.cleanup(journal);
  }
  private async restore(journal: AdoptionJournal, index: number) {
    const operation = journal.operations[index]!;
    if (!operation.started) return;
    const lock = this.lock(journal),
      target = await guardedTarget(journal.originalPath, operation.path);
    const actual = await fileState(journal.originalPath, operation.path),
      captured = await fileState(lock, `${index}-captured`);
    if (sameFile(actual, operation.before)) {
      if (captured && !sameFile(captured, operation.before))
        throw new Error(`保留的原件含后续修改，需人工核对：${operation.path}`);
      return;
    }
    if (actual && !sameFile(actual, operation.after))
      throw new Error(`文件已有后续修改，不覆盖：${operation.path}`);
    if (operation.before && !captured)
      throw new Error(`原件缺失，不猜测恢复：${operation.path}`);
    if (actual) {
      const reverted = join(lock, `${index}-reverted`);
      await rename(target, reverted);
      await syncDirectory(dirname(target));
      await syncDirectory(lock);
      if (
        !sameFile(await fileState(lock, `${index}-reverted`), operation.after)
      ) {
        await link(reverted, target);
        await syncDirectory(dirname(target));
        throw new Error(`恢复时文件变化，已保留修改：${operation.path}`);
      }
    }
    if (captured) {
      await guardedTarget(journal.originalPath, operation.path);
      await link(join(lock, `${index}-captured`), target);
      await syncDirectory(dirname(target));
    }
  }
  /** 提交/回滚日志先持久化，再清理自身临时文件；未知额外文件阻止清理。 */
  async cleanup(journal: AdoptionJournal) {
    await assertOriginalRoot(journal);
    if (await this.ownedLock(journal)) {
      const lock = this.lock(journal),
        allowed = new Set([
          "owner.json",
          ...journal.operations.flatMap((_, index) => [
            `${index}-after`,
            `${index}-captured`,
            `${index}-reverted`,
          ]),
        ]);
      const names = await readdir(lock);
      if (names.some((name) => !allowed.has(name)))
        throw new Error("应用临时目录含未知文件，保留待人工核对");
      for (const [index, operation] of journal.operations.entries()) {
        const captured = await fileState(lock, `${index}-captured`);
        if (
          captured &&
          !sameFile(captured, operation.before) &&
          !sameFile(
            captured,
            await fileState(journal.originalPath, operation.path),
          )
        )
          throw new Error(`原件出现后续修改，保留不清理：${operation.path}`);
      }
      for (const name of names.filter((name) => name !== "owner.json"))
        await unlink(join(lock, name));
      await syncDirectory(lock);
      if (names.includes("owner.json")) await unlink(join(lock, "owner.json"));
      await rmdir(lock);
      await syncDirectory(journal.originalPath);
    }
    journal.state.cleanupPending = false;
    delete journal.state.error;
    await this.repository.save(journal);
  }
}
