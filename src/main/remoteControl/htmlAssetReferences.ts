// 沙箱页不携带主登录 Cookie。仅允许它读取已交付的 HTML、样式和脚本实际引用的静态资源。
const RESOURCE_EXTENSION = /\.(?:css|m?js|png|jpe?g|gif|webp|svg|ico|avif|woff2?|[ot]tf)$/i;
const RELATIVE_RESOURCE = /(?:\b(?:src|href)\s*=\s*["']([^"']+)["']|url\(\s*["']?([^)'"]+)["']?\s*\)|(?:@import\s+|\bfrom\s+|\bimport\s*\(?\s*)["']([^"']+)["'])/gi;
const MAX_REFERENCES = 2048;

/** 引用按资源自身的位置解析；只记录本预览地址内的静态文件，不生成目录级通行证。 */
export function collectHtmlAssets(text: string, base: URL, allowed: Set<string>) {
  for (const match of text.matchAll(RELATIVE_RESOURCE)) {
    if (allowed.size >= MAX_REFERENCES) break;
    const url = URL.parse(match[1] ?? match[2] ?? match[3]!, base);
    if (url?.protocol === base.protocol && url.host === base.host && RESOURCE_EXTENSION.test(url.pathname)) {
      allowed.add(url.pathname);
    }
  }
}
