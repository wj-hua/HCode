// 已验证的包管理器运行时布局；只开放工具安装目录，不扩大到用户 HOME。
import { readFile, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

/** 支持 pnpm 的标准 JS 入口及当前 Codex bundled wrapper；未知 wrapper 保持沙箱拒绝。 */
export async function validationRuntimeReads(executable: string): Promise<string[]> {
  const canonical = await realpath(executable), directory = dirname(canonical);
  const reads = [directory];
  if (canonical.endsWith('/pnpm/bin/pnpm.cjs') || canonical.endsWith('/pnpm/bin/pnpm.mjs')) reads.push(resolve(directory, '..'));
  if (!canonical.endsWith('/dependencies/bin/fallback/pnpm')) return reads;
  const body = await readFile(canonical, 'utf8');
  const expected = '#!/usr/bin/env bash\nset -euo pipefail\nSCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"\nexport pnpm_config_pm_on_fail=ignore\nexec "${SCRIPT_DIR}/../../node/bin/node" "${SCRIPT_DIR}/../../node/node_modules/pnpm/bin/pnpm.mjs" "$@"\n';
  if (body !== expected) throw new Error('pnpm wrapper 内容与已验证布局不一致，拒绝扩大读取权限');
  reads.push(await realpath(join(directory, '../../node')));
  return reads;
}

/** 将已识别的 pnpm wrapper 转成等价 Node 入口，避免系统 bash 清除 DYLD 兼容库。 */
export async function normalizeValidationCommand(executable: string, args: string[]) {
  const canonical = await realpath(executable);
  if (!canonical.endsWith('/dependencies/bin/fallback/pnpm')) return { executable: canonical, args };
  await validationRuntimeReads(canonical);
  const runtime = resolve(dirname(canonical), '../../node');
  return { executable: join(runtime, 'bin/node'), args: [join(runtime, 'node_modules/pnpm/bin/pnpm.mjs'), ...args] };
}
