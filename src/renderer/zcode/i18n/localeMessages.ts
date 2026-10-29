// 词典按实际语言加载；Suspense 等待同一份请求，失败交给页面错误边界明确呈现。
import type { Locale } from "@zcode/shared";

const dictionaries = new Map<Locale, Record<string, string>>();
const pending = new Map<Locale, Promise<void>>();
const failures = new Map<Locale, unknown>();
const loaders = {
  "zh-CN": () => import("./locales/zh-CN.js"),
  "en-US": () => import("./locales/en-US.js"),
};

export function readLocaleMessages(locale: Locale): Record<string, string> {
  if (failures.has(locale)) throw failures.get(locale);
  const messages = dictionaries.get(locale);
  if (messages) return messages;
  throw loadLocaleMessages(locale);
}

/** 服务端同步渲染或宿主预热可先等待词典，正常浏览器渲染由 Suspense 等待。 */
export function loadLocaleMessages(locale: Locale): Promise<void> {
  if (dictionaries.has(locale)) return Promise.resolve();
  if (failures.has(locale)) return Promise.reject(failures.get(locale));
  let request = pending.get(locale);
  if (!request) {
    request = loaders[locale]().then(module => { dictionaries.set(locale, module.default); pending.delete(locale); }, error => { failures.set(locale, error); throw error; });
    pending.set(locale, request);
  }
  return request;
}
