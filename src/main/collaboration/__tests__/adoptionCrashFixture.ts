// 独立子进程强制终止点；只在父测试创建的临时项目执行，不调用模型。
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CollaborationRepository } from "../collaborationRepository.js";
import { WorkspaceService } from "../workspaces/workspaceService.js";
import { CodeAdoptionService } from "../adoption/codeAdoptionService.js";
import { snapshotSchema } from "../contracts.js";
const root = process.argv[2];
if (!root) throw new Error("缺少父测试的临时目录");
const snapshot = snapshotSchema.parse(
  JSON.parse(await readFile(join(root, "input.json"), "utf8")),
);
const repository = new CollaborationRepository(join(root, "records"));
const adoption = new CodeAdoptionService(
  new WorkspaceService(repository.root),
  repository,
  async (stage) => {
    if (stage === "afterFile") process.kill(process.pid, "SIGKILL");
  },
);
const version = snapshot.code!.versions.at(-1)!;
const preview = await adoption.preview(snapshot, version.id);
await adoption.apply(snapshot, {
  versionId: version.id,
  previewHash: preview.hash,
});
throw new Error("进程没有在预定点终止");
