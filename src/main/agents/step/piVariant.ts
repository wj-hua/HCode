// StepCode 基于 pi：两者的 RPC 协议（`--mode rpc`）与会话 JSONL 格式相同，共用 step/ 下的接入代码。
// 差异（命令、会话目录、启动参数、工具名）集中在 PiVariant 里，StepCode 与 pi 各提供一份。
import type { PermissionMode } from "../../../shared/types.js";
import type { JsonRecord } from "../rowProjectorBase.js";

export type ProjectTool = (name: string, args: JsonRecord) => { toolName: string; input: JsonRecord };

export interface PiVariant {
  kind: "step" | "pi";
  /** 界面与错误信息里的名称 */
  name: string;
  command: string;
  /** 优先于 PATH 查找的安装位置 */
  preferredBin?: string;
  /** 会话 JSONL 的根目录（子目录按项目划分，也可能直接放在根目录下）。 */
  sessionsDir(env: Record<string, string>): string;
  /** 权限模式对应的启动参数（模型、会话参数由会话自己追加）。 */
  launchArgs(mode: PermissionMode): string[];
  /** CLI 工具调用 → ZCode 工具名 + 输入 */
  projectTool: ProjectTool;
}
