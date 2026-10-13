// 只读研究的运行时策略；权限在工具/沙箱边界执行，不由提示词承担。
import { z } from "zod";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { realpath, readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import { listProjectFiles } from "../projectFiles.js";

export const CODEX_RESEARCH_PROTOCOL_VERSION = "0.162.0";
export const RESEARCH_PERMISSION_PROFILE = "hcode_research";
export const RESEARCH_MCP_NAME = "hcode";
const MAX_READ_BYTES = 256 * 1024;

export interface HostedTool {
  name: string;
  description: string;
  schema: z.ZodRawShape;
  execute(input: Record<string, unknown>): Promise<unknown>;
}

export interface ResearchRuntime {
  root: string;
  tools?: HostedTool[];
  outputSchema?: Record<string, unknown>;
  /** 宿主记录实际工具读取的证据版本；回调失败作为工具错误返回。 */
  onRead?(file: { path: string; content: string; hash: string }): Promise<void>;
}

/** 拒绝相对逃逸和外部符号链接；返回 canonical 路径用于真正的读取。 */
export async function researchPath(root: string, path: string): Promise<string> {
  const canonicalRoot = await realpath(root);
  const canonicalPath = await realpath(isAbsolute(path) ? path : resolve(canonicalRoot, path));
  const child = relative(canonicalRoot, canonicalPath);
  if (child === ".." || child.startsWith("../") || isAbsolute(child)) throw new Error("读取路径超出本次项目范围");
  return canonicalPath;
}

/** 有界文本读取带内容 hash，供报告与审查核对证据版本。 */
export async function readResearchFile(root: string, path: string) {
  const canonical = await researchPath(root, path);
  const info = await stat(canonical);
  if (!info.isFile() || info.size > MAX_READ_BYTES) throw new Error("研究读取仅支持 256 KiB 以内的文本文件");
  const bytes = await readFile(canonical);
  if (bytes.length > MAX_READ_BYTES || bytes.includes(0)) throw new Error("研究文件过大或包含二进制内容");
  return { path: relative(await realpath(root), canonical), content: new TextDecoder("utf-8", { fatal: true }).decode(bytes), hash: createHash("sha256").update(bytes).digest("hex") };
}

export function researchTools(runtime: ResearchRuntime): HostedTool[] {
  return [
    { name: "read_file", description: "读取本次项目内文本，返回内容与 hash；无写入权限", schema: { path: z.string().min(1) }, execute: async (input) => { const file = await readResearchFile(runtime.root, String(input.path)); await runtime.onRead?.(file); return file; } },
    { name: "list_files", description: "按名称检索本次项目内文件；返回相对路径", schema: { query: z.string() }, execute: (input) => listProjectFiles(runtime.root, String(input.query)) },
    ...(runtime.tools ?? []),
  ];
}

export function researchMcp(runtime: ResearchRuntime) {
  const definitions = researchTools(runtime);
  return createSdkMcpServer({ name: RESEARCH_MCP_NAME, version: "1.0.0", tools: definitions.map((definition) => tool(
    definition.name, definition.description, definition.schema, async (input) => {
      try {
        const result = await definition.execute(input as Record<string, unknown>);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) {
        // MCP 工具失败必须回到模型和任务记录；禁止用空结果掩盖越界或 IO 错误。
        return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
      }
    },
  )) });
}

/** 显式关闭已发现的外部 MCP/插件及 hooks，配置只传给研究线程，不写全局配置。 */
export function codexResearchConfig(root: string, config: Record<string, unknown>) {
  const disableEntries = (value: unknown) => Object.fromEntries(Object.keys(z.record(z.string(), z.unknown()).parse(value ?? {})).map((name) => [name, { enabled: false }]));
  return {
    permissions: { [RESEARCH_PERMISSION_PROFILE]: { filesystem: { ":minimal": "read", [root]: "read" }, network: { enabled: false } } },
    mcp_servers: disableEntries(config.mcp_servers), plugins: disableEntries(config.plugins),
    features: { hooks: false, apps: false, multi_agent: false, multi_agent_v2: false, browser_use: false, computer_use: false, image_generation: false },
    notify: [], web_search: "disabled",
  };
}
