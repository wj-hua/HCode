// 发现与冻结本机专家配置，按已冻结摘要读取职责和资源；不执行脚本或修改源配置。
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { z } from "zod";
import type { SkillEntry } from "../../../../shared/types.js";
import type { ExpertSelection } from "../../../../shared/experts.js";
import type { ExpertProfileSnapshot } from "../../../../shared/expertProfiles.js";
import { discoverExpertSkillSources } from "../../../extensions/expertSkillSources.js";
import {
  profileCatalog,
  profileHash,
  profileInstructions,
} from "./profileCatalog.js";
import { contentHash } from "./profileFiles.js";
import {
  profileSnapshotSchema,
  profileHashSchema,
} from "./profileContracts.js";
import { PROFILE_DEFINITIONS } from "./profileDefinitions.js";
interface Options {
  home?: string;
  discoverSkills?: (project: string) => Promise<SkillEntry[]>;
}
export class ExpertProfileService {
  constructor(
    private readonly root: string,
    private readonly options: Options = {},
  ) {}
  private async bundles(project: string) {
    const home = this.options.home ?? homedir();
    const managed = this.options.discoverSkills
      ? await this.options.discoverSkills(project)
      : [];
    const pluginNames = [
      ...new Set(
        Object.values(PROFILE_DEFINITIONS)
          .flatMap((definition) => definition.skills)
          .filter((name) => name.includes(":")),
      ),
    ];
    const skills = await discoverExpertSkillSources(
      home,
      project,
      managed,
      pluginNames,
    );
    return profileCatalog(join(home, ".codex/agents"), skills);
  }
  async catalog(project: string) {
    return (await this.bundles(project)).map((bundle) => bundle.profile);
  }
  /** 客户端只传已预览的 hash；源文件变化或组合不完整时拒绝启动。 */
  async freeze(
    runId: string,
    project: string,
    selections: ExpertSelection[],
    acceptLimitations: boolean,
  ) {
    const bundles = await this.bundles(project),
      selected: typeof bundles = [];
    for (const selection of selections) {
      const bundle = bundles.find(
        (entry) => entry.profile.role === selection.role,
      );
      if (!bundle) {
        if (selection.profileHash)
          throw new Error("通用专家不能指定本机组合 hash");
        continue;
      }
      if (bundle.profile.issues.length)
        throw new Error(bundle.profile.issues.join("\n"));
      if (selection.profileHash !== bundle.profile.hash)
        throw new Error("本机角色或 Skill 已变化，请刷新专家配置并重新确认");
      if (!acceptLimitations)
        throw new Error("请先确认角色/Skills 的只读适配与未接入工具限制");
      selected.push(bundle);
    }
    const result = selected.map((bundle) => {
      const { issues, ...profile } = bundle.profile;
      return profileSnapshotSchema.parse(profile);
    });
    for (const bundle of selected)
      for (const [hash, content] of bundle.contents)
        await this.writeContent(runId, hash, content);
    return result;
  }
  private file(runId: string, hash: string) {
    return join(
      this.root,
      z.string().uuid().parse(runId),
      "artifacts",
      "expert-profiles",
      `${profileHashSchema.parse(hash)}.txt`,
    );
  }
  private async writeContent(runId: string, hash: string, content: string) {
    const path = this.file(runId, hash);
    await mkdir(join(path, ".."), { recursive: true });
    try {
      await writeFile(path, content, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await this.readContent(runId, hash);
    }
  }
  private async readContent(runId: string, hash: string) {
    const content = await readFile(this.file(runId, hash), "utf8");
    if (contentHash(content) !== hash)
      throw new Error("冻结专家配置内容 hash 不符，不能继续");
    return content;
  }
  /** 职责和主 Skill 全文装入任务；关联资源只能读取本专家的已冻结白名单。 */
  async packet(runId: string, input: ExpertProfileSnapshot) {
    const profile = profileSnapshotSchema.parse(input),
      { hash, ...base } = profile;
    if (profileHash(base) !== hash) throw new Error("冻结专家配置摘要不符");
    const contents = new Map<string, string>();
    for (const ref of [...profile.roles, ...profile.skills])
      contents.set(ref.hash, await this.readContent(runId, ref.hash));
    const instructions = profileInstructions(profile, contents);
    const readResource = async (skill: string, path: string) => {
      const ref = profile.resources.find(
        (entry) => entry.skill === skill && entry.name === path,
      );
      if (!ref) throw new Error("资源不属于本专家冻结的 Skill 白名单");
      return {
        skill,
        path,
        hash: ref.hash,
        content: await this.readContent(runId, ref.hash),
      };
    };
    return { instructions, readResource };
  }
}
