// 远程操控 HTTP 响应压缩：隧道带宽很小（实测约 180 KB/s），界面脚本与会话快照必须压缩后再发。
// 只处理一次性响应体；SSE 事件流逐条推送，不经过这里。
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";

export type ContentEncoding = "br" | "gzip";

/** 构建产物只在启动时读取，压缩一次后可反复使用，因此取更高的压缩率。 */
const STATIC_BROTLI_QUALITY = 9;
/** 每次请求现场压缩，取速度与压缩率的折中（3 MB 约 50 ms）。 */
const DYNAMIC_BROTLI_QUALITY = 5;
/** 小于此长度时压缩收益抵不过编码开销。 */
export const MIN_COMPRESS_BYTES = 1024;

const COMPRESSIBLE_TYPE = /^(text\/|application\/(json|javascript|wasm)|image\/svg\+xml)/;

const brotli = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

/** 按 Accept-Encoding 选择编码，优先 br；客户端都不支持时返回 null。 */
export function negotiateEncoding(acceptEncoding: string | string[] | undefined): ContentEncoding | null {
  const accepted = new Set<string>();
  for (const part of [acceptEncoding ?? ""].flat().join(",").split(",")) {
    const [name, ...params] = part.trim().toLowerCase().split(";");
    if (name && !params.some((param) => /^\s*q=0(\.0*)?\s*$/.test(param))) accepted.add(name);
  }
  if (accepted.has("br")) return "br";
  if (accepted.has("gzip")) return "gzip";
  return null;
}

export function isCompressible(contentType: string, length: number): boolean {
  return length >= MIN_COMPRESS_BYTES && COMPRESSIBLE_TYPE.test(contentType);
}

/** 在 libuv 线程池中压缩，不阻塞 Electron 主进程。 */
export function compress(data: Buffer, encoding: ContentEncoding, mode: "static" | "dynamic"): Promise<Buffer> {
  if (encoding === "gzip") return gzipAsync(data);
  return brotli(data, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: mode === "static" ? STATIC_BROTLI_QUALITY : DYNAMIC_BROTLI_QUALITY,
      [constants.BROTLI_PARAM_SIZE_HINT]: data.length,
    },
  });
}
