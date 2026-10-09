// 非项目对话的共享工作目录：由 HCode 管理，独立于用户添加的项目，重启后保留文件。
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

export class ConversationWorkspace {
  readonly path: string;

  constructor(dataDirectory: string) {
    this.path = join(dataDirectory, "workspace", "default");
  }

  /** 首次使用时创建目录；路径被文件占用、无权限等错误直接交给调用方显示。 */
  async ensure(): Promise<string> {
    await mkdir(this.path, { recursive: true });
    return this.path;
  }
}
