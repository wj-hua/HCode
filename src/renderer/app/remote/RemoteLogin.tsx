// 远程操控登录页：口令在电脑上的 HCode 设置中复制。
import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { useUiStore } from "../store/uiStore";
import { remoteLogin } from "../remoteBridge";

export function RemoteLogin() {
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  useEffect(() => useUiStore.getState().setTheme("system"), []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!token.trim() || pending) return;
    setPending(true);
    setError("");
    try {
      await remoteLogin(token.trim());
      location.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setPending(false);
    }
  };

  return (
    <div className="flex h-dvh items-center justify-center bg-background p-6 text-foreground">
      <form onSubmit={submit} className="flex w-full max-w-sm flex-col gap-3">
        <h1 className="text-lg font-medium">HCode 远程操控</h1>
        <p className="text-ui-base text-foreground-subtle">输入电脑上 HCode「设置 → 远程操控」中的访问口令。</p>
        <Input
          size="lg"
          type="password"
          autoComplete="current-password"
          autoFocus
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder="访问口令"
          aria-invalid={error ? true : undefined}
        />
        {error ? <p className="text-ui-base text-destructive">{error}</p> : null}
        <Button type="submit" size="lg" disabled={!token.trim() || pending}>{pending ? "登录中…" : "登录"}</Button>
      </form>
    </div>
  );
}
