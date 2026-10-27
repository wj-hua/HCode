import { useState } from "react";
import { AlertCircleIcon, LoaderIcon } from "lucide-react";
import type { GitBranchSwitchPreview } from "@hcode/shared/types";
import { Button } from "@/components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog.js";
import { toast } from "@/components/ui/toast.js";
import { hcode } from "../bridge";
import { errorMessage } from "../store/appStore";

export function GitSwitchAssistDialog({ projectPath, target, initialPreview, running, onClose, onChanged }: {
  projectPath: string;
  target: string;
  initialPreview: GitBranchSwitchPreview;
  running: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [preview, setPreview] = useState(initialPreview);
  const [step, setStep] = useState<"blocked" | "commit">("blocked");
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const fileCount = new Set(preview.files.map((file) => file.path)).size;
  const additions = preview.files.reduce((sum, file) => sum + (file.additions ?? 0), 0);
  const deletions = preview.files.reduce((sum, file) => sum + (file.deletions ?? 0), 0);

  const refresh = async () => {
    setPending(true);
    try {
      setPreview(await hcode.invoke("git:branchSwitchPreview", projectPath));
      setError(null);
      setStep("blocked");
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setPending(false); }
  };

  const submit = async () => {
    if (pending || running || !preview.files.length || !preview.identityReady) return;
    setPending(true);
    setError(null);
    try {
      const commitMessage = message.trim() || `chore: checkpoint before switching to ${target}`;
      const result = await hcode.invoke("git:commitAndSwitch", projectPath, target, commitMessage, preview);
      onChanged();
      onClose();
      if (result.switched) toast(`已提交更改并切换到分支 ${target}`);
      else toast(`更改已提交，但切换分支失败：${result.error}`, { variant: "warning", durationMs: 8000 });
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setPending(false); }
  };

  return <Dialog open onOpenChange={(open) => { if (!open && !pending) onClose(); }}>
    <DialogContent className="flex max-h-[calc(100dvh-2rem)] min-h-0 flex-col sm:max-w-lg">
      <DialogHeader className="pr-8">
        <DialogTitle>{step === "blocked" ? "提交更改以切换分支" : "提交更改"}</DialogTitle>
        <DialogDescription>{step === "blocked" ? `切换到 ${target} 会覆盖当前更改。` : `提交后将继续切换到 ${target}。`}</DialogDescription>
      </DialogHeader>
      <div className="min-h-0 space-y-4 overflow-y-auto overscroll-contain">
        {step === "blocked" ? <>
          <div className="flex items-start gap-2 rounded-lg bg-warning/10 p-3 text-ui-base text-warning"><AlertCircleIcon className="mt-0.5 size-4 shrink-0" /><p>继续操作会暂存并提交此仓库中的全部更改，包括已暂存和未暂存的文件。</p></div>
          <div className="rounded-lg border border-border bg-surface p-3">
            <div className="mb-2 font-medium">更改 · {fileCount} 个文件</div>
            <div className="max-h-48 space-y-1 overflow-y-auto overscroll-contain">{preview.files.map((file) => <div key={`${file.status}:${file.path}`} className="flex min-w-0 items-center gap-2 rounded px-1 py-1.5"><span className="shrink-0 font-mono text-foreground-subtle">{file.status.trim()}</span><span className="min-w-0 flex-1 break-all">{file.path}</span>{file.additions !== null ? <span className="shrink-0 text-green-600">+{file.additions}</span> : null}{file.deletions !== null ? <span className="shrink-0 text-red-600">−{file.deletions}</span> : null}</div>)}</div>
          </div>
        </> : <>
          <div className="rounded-lg bg-surface p-3 text-ui-base"><div>当前分支：{preview.branch ?? "分离的 HEAD"}</div><div className="mt-2">更改：{fileCount} 个文件 <span className="text-green-600">+{additions}</span> <span className="text-red-600">−{deletions}</span></div></div>
          {!preview.identityReady ? <p className="rounded-lg bg-warning/10 p-3 text-ui-base text-warning">未配置 Git 提交身份，请先在运行 HCode 的电脑上设置用户名和邮箱，再重新读取更改。</p> : null}
          <label className="block space-y-2 text-ui-base"><span>提交信息</span><textarea value={message} disabled={pending} onChange={(event) => setMessage(event.target.value)} placeholder="留空以自动生成提交信息" className="min-h-24 w-full rounded-lg border border-input-border bg-input p-3 text-ui-base outline-none focus-visible:border-input-border-focused" /></label>
          {!preview.identityReady ? <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => void refresh()}>重新读取更改</Button> : null}
        </>}
        {running ? <p className="text-ui-base text-warning">该仓库有会话正在运行，请结束后再操作 Git。</p> : null}
        {error ? <div role="alert" className="space-y-2 break-words text-ui-base text-destructive"><p>{error}</p><Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => void refresh()}>重新读取更改</Button></div> : null}
      </div>
      <DialogFooter className="shrink-0 sm:flex-row">
        <Button type="button" variant="secondary" size="lg" className="h-10 px-4" disabled={pending} onClick={onClose}>取消</Button>
        {step === "blocked" ? <Button type="button" size="lg" className="h-10 px-4" disabled={pending || running || !preview.files.length} onClick={() => setStep("commit")}>提交并切换分支…</Button> : <Button type="button" size="lg" className="h-10 px-4" disabled={pending || running || !preview.files.length || !preview.identityReady} onClick={() => void submit()}>{pending ? <LoaderIcon className="size-4 animate-spin" /> : null}提交并切换分支</Button>}
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
