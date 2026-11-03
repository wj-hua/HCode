// 大文本按用户操作逐页追加。切换文件或刷新会重建组件，旧请求不能覆盖新文件。
import { useEffect, useRef, useState } from "react";
import { remoteBridge } from "../bridge";
import type { RemoteTextPage } from "@hcode/shared/remoteControl";
import { Button } from "@/components/ui/button.js";

export function PagedTextPreview({ path, first }: { path: string; first: RemoteTextPage }) {
  const [page, setPage] = useState(first);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  async function loadMore() {
    if (page.next === null || busy) return;
    setBusy(true);
    setError("");
    try {
      const part = await remoteBridge!.readTextPage(path, page.next, page.version);
      if (active.current) setPage({ ...part, text: page.text + part.text });
    } catch (cause) {
      if (active.current) setError(String(cause));
    } finally { if (active.current) setBusy(false); }
  }
  return <div className="p-4"><pre className="whitespace-pre-wrap break-all">{page.text}</pre>
    {error && <p role="alert">{error}</p>}
    {page.next !== null && <Button disabled={busy} onClick={() => void loadMore()}>{busy ? "正在读取…" : "继续读取"}</Button>}
  </div>;
}
