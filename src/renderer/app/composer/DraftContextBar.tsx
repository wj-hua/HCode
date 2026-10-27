// 新会话输入框下方的「文件夹 / 分支」选择：参照 ZCode ChatEmptyWorkspacePreviewMenu 与 GitBranchSwitcher。
import { ChevronDownIcon, FolderIcon, FolderPlusIcon, GitBranchIcon, GitGraphIcon, LoaderIcon, MessageCircleIcon, PlusIcon, SearchIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { GitBranches, GitBranchSwitchPreview } from "@hcode/shared/types";
import { cn } from "@/components/lib/utils.js";
import { isCoarseTouchDevice } from "@/lib/pickerFocus.js";
import { Button } from "@/components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { toast } from "@/components/ui/toast.js";
import { hcode, isRemote } from "../bridge";
import { shortenHome } from "../format";
import { errorMessage, useAppStore, type Conversation } from "../store/appStore";
import { GitGraphDialog } from "./GitGraphDialog";
import { GitSwitchAssistDialog } from "./GitSwitchAssistDialog";

function MenuSearch({ value, onChange, placeholder, autoFocus = true, stopMenuKeys = true }: { value: string; onChange: (value: string) => void; placeholder: string; autoFocus?: boolean; stopMenuKeys?: boolean }) {
  return (
    // 阻止按键冒泡，否则菜单的首字母跳转会抢走输入
    <div className="flex items-center gap-2 border-b border-border px-3 py-2" onKeyDown={(event) => { if (stopMenuKeys && event.key !== "Escape" && event.key !== "Tab") event.stopPropagation(); }}>
      <SearchIcon className="size-4 shrink-0 text-foreground-subtlest" />
      <input
        autoFocus={autoFocus}
        aria-label={placeholder}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="w-full bg-transparent text-ui-base text-foreground outline-none placeholder:text-foreground-subtlest"
      />
    </div>
  );
}

function matches(query: string, ...texts: string[]): boolean {
  const q = query.trim().toLowerCase();
  return !q || texts.some((text) => text.toLowerCase().includes(q));
}

function FolderPicker({ conversation }: { conversation: Conversation }) {
  const projects = useAppStore((state) => state.projects);
  const setDraftProject = useAppStore((state) => state.setDraftProject);
  const addProject = useAppStore((state) => state.addProject);
  const workOutsideProject = useAppStore((state) => state.workOutsideProject);
  const pending = useAppStore((state) => state.conversationWorkspacePending);
  const outsideProject = projects.some((project) => project.path === conversation.projectPath && project.purpose === "conversation");
  const [query, setQuery] = useState("");
  const name = outsideProject ? "选择项目" : conversation.projectPath.split("/").filter(Boolean).at(-1) ?? conversation.projectPath;
  const visible = projects.filter((project) => project.purpose !== "conversation" && project.exists && matches(query, project.name, project.path));

  return (
    <DropdownMenu onOpenChange={(open) => !open && setQuery("")}>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="sm" disabled={pending} className="min-w-0 max-w-60 gap-1.5 rounded-full text-foreground-subtle">
          <FolderIcon className="size-4 shrink-0" />
          <span className="truncate">{name}</span>
          <ChevronDownIcon className="size-3 shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-80 p-0">
        <MenuSearch value={query} onChange={setQuery} placeholder="搜索项目" />
        <div className="max-h-64 overflow-y-auto p-1">
          {visible.map((project) => (
            <DropdownMenuCheckboxItem
              key={project.path}
              checked={project.path === conversation.projectPath}
              onSelect={() => setDraftProject(project.path)}
            >
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate">{project.name}</span>
                <span className="truncate text-ui-sm text-foreground-subtlest">{shortenHome(project.path)}</span>
              </span>
            </DropdownMenuCheckboxItem>
          ))}
          {visible.length === 0 ? <div className="px-2 py-2 text-ui-base text-foreground-subtlest">没有匹配的项目</div> : null}
        </div>
        <div className="border-t border-border p-1">
          <DropdownMenuItem onSelect={() => void addProject()}>
            <FolderPlusIcon className="size-4 text-foreground-subtle" />
            添加项目文件夹…
          </DropdownMenuItem>
          <DropdownMenuCheckboxItem checked={outsideProject} disabled={pending} onSelect={() => void workOutsideProject()}>
            <MessageCircleIcon className="size-4 text-foreground-subtle" />
            不在项目中工作
          </DropdownMenuCheckboxItem>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function BranchPicker({ projectPath, onChanged }: { projectPath: string; onChanged?: () => void }) {
  // undefined = 读取中；null = 不是 git 仓库
  const [git, setGit] = useState<GitBranches | null | undefined>(undefined);
  const [pending, setPending] = useState(false);
  const [query, setQuery] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [graphOpen, setGraphOpen] = useState(false);
  const [assist, setAssist] = useState<{ target: string; preview: GitBranchSwitchPreview } | null>(null);
  const [branchName, setBranchName] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const requestId = useRef(0);
  const branchListRef = useRef<HTMLDivElement>(null);
  const running = useAppStore((state) => Object.values(state.conversations).some((item) => {
    const root = item.projectPath;
    return (item.runState === "running" || item.runState === "awaitingApproval")
      && (root === projectPath || root.startsWith(`${projectPath}/`) || projectPath.startsWith(`${root}/`));
  }));

  const load = useCallback(async () => {
    const request = ++requestId.current;
    try {
      const result = await hcode.invoke("git:branches", projectPath);
      if (request === requestId.current) setGit(result);
    } catch {
      if (request === requestId.current) setGit((previous) => previous === undefined ? null : previous);
    }
  }, [projectPath]);

  useEffect(() => {
    setGit(undefined);
    void load();
    return () => { requestId.current++; };
  }, [load]);

  useEffect(() => {
    const refresh = () => void load();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [load]);

  useEffect(() => {
    if (!menuOpen) return;
    const frame = window.requestAnimationFrame(() => branchListRef.current?.querySelector<HTMLElement>('[aria-current="true"]')?.scrollIntoView({ block: "nearest" }));
    return () => window.cancelAnimationFrame(frame);
  }, [menuOpen, git]);

  if (!git) return null;
  const visible = git.branches.filter((branch) => matches(query, branch));

  const switchTo = async (branch: string) => {
    if (pending || running || branch === git.current) return;
    setPending(true);
    try {
      const result = await hcode.invoke("git:switchBranch", projectPath, branch);
      if (result.ok) {
        onChanged?.();
        toast(`已切换到分支 ${branch}`);
      } else {
        const preview = await hcode.invoke("git:branchSwitchPreview", projectPath);
        setAssist({ target: branch, preview });
      }
    } catch (error) {
      toast(`切换分支失败：${errorMessage(error)}`, { variant: "warning" });
    } finally {
      await load();
      setPending(false);
    }
  };
  const create = async () => {
    if (pending || running || !branchName.trim()) return;
    setPending(true);
    setCreateError(null);
    try {
      await hcode.invoke("git:createBranch", projectPath, branchName.trim());
      onChanged?.();
      setCreateOpen(false);
      toast("已创建并切换到新分支");
    } catch (error) {
      setCreateError(errorMessage(error));
    } finally {
      await load();
      setPending(false);
    }
  };

  return (
    <>
      <Popover
        open={menuOpen}
        onOpenChange={(open) => {
          setMenuOpen(open);
          // 每次展开都重新读取，外部切过分支也能看到最新状态
          if (open) void load();
          else setQuery("");
        }}
      >
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size={isRemote ? "icon-lg" : "sm"}
            disabled={pending || running}
            aria-label="切换 Git 分支"
            title={git.current ?? "分离的 HEAD"}
            className={cn("min-w-0 max-w-60 gap-1.5 rounded-full text-foreground-subtle", isRemote && "shrink-0")}
          >
            <GitBranchIcon className="size-4 shrink-0" />
            {!isRemote ? <><span className="truncate">{git.current ?? "分离的 HEAD"}</span>{pending ? <LoaderIcon className="size-3 shrink-0 animate-spin" /> : <ChevronDownIcon className="size-3 shrink-0" />}</> : null}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" side="top" avoidCollisions={false} className="w-72 max-h-(--radix-popover-content-available-height) max-w-[calc(100vw-2rem)] gap-0 bg-menu p-0" onOpenAutoFocus={(event) => {
          event.preventDefault();
          if (!isCoarseTouchDevice()) (event.currentTarget as HTMLElement).querySelector<HTMLInputElement>('input[aria-label="搜索分支"]')?.focus();
        }} onCloseAutoFocus={(event) => { if (isCoarseTouchDevice() || graphOpen || createOpen) event.preventDefault(); }} onKeyDown={(event) => {
          const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-git-branch]:not(:disabled)')];
          if (!items.length) return;
          if (event.key === "Enter" && event.target instanceof HTMLInputElement) { event.preventDefault(); items[0]?.click(); return; }
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          const index = items.findIndex((item) => item === document.activeElement);
          const next = event.key === "ArrowDown" ? Math.min(index + 1, items.length - 1) : index < 0 ? items.length - 1 : Math.max(index - 1, 0);
          event.preventDefault();
          items[next]?.focus();
        }}>
          <MenuSearch value={query} onChange={setQuery} placeholder="搜索分支" autoFocus={false} stopMenuKeys={false} />
          <div ref={branchListRef} className="min-h-0 max-h-48 overflow-y-auto overscroll-contain p-1">
            <div className="px-3 py-2 font-medium text-foreground-subtle">分支</div>
            {visible.map((branch) => (
              <button
                type="button"
                key={branch}
                data-git-branch="true"
                aria-current={branch === git.current ? "true" : undefined}
                disabled={pending || running}
                onClick={() => { setMenuOpen(false); setQuery(""); void switchTo(branch); }}
                className="flex min-h-10 w-full items-start gap-3 rounded-lg px-3 py-2 text-left text-ui-base active:bg-menu-hover hover:bg-menu-hover disabled:opacity-50"
              >
                <GitBranchIcon className="size-4 shrink-0 text-foreground-subtle" />
                <span className="flex min-w-0 flex-1 flex-col"><span className="truncate">{branch}</span>{branch === git.current && git.dirtyFileCount ? <span className="text-ui-sm text-foreground-subtle">未提交的更改：{git.dirtyFileCount} 个文件</span> : null}</span>
                {branch === git.current ? <span className="text-foreground-subtle" aria-label="当前分支">✓</span> : null}
              </button>
            ))}
            {visible.length === 0 ? <div className="px-2 py-2 text-ui-base text-foreground-subtlest">没有匹配的分支</div> : null}
          </div>
          <div className="border-t border-border p-1">
            <Button type="button" variant="ghost" size="lg" className="h-10 w-full justify-start px-2" disabled={pending || running} onClick={() => { setMenuOpen(false); setQuery(""); setBranchName(""); setCreateError(null); setCreateOpen(true); }}>
              <PlusIcon className="size-4" />创建并检出新分支…
            </Button>
            <Button type="button" variant="ghost" size="lg" className="h-10 w-full justify-start px-2" onClick={() => { setMenuOpen(false); setQuery(""); setGraphOpen(true); }}><GitGraphIcon className="size-4" />Git 图谱</Button>
          </div>
        </PopoverContent>
      </Popover>
      <Dialog open={createOpen} onOpenChange={(open) => { if (!pending) setCreateOpen(open); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>创建并检出新分支</DialogTitle>
            <DialogDescription>从当前 HEAD 创建并切换到新分支。</DialogDescription>
          </DialogHeader>
          <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void create(); }}>
            <Input autoFocus aria-label="分支名称" placeholder="例如 feature/my-change" value={branchName} disabled={pending || running} onChange={(event) => setBranchName(event.target.value)} />
            {createError ? <p role="alert" className="break-words text-ui-sm text-destructive">{createError}</p> : null}
            <DialogFooter>
              <Button type="button" variant="outline" disabled={pending} onClick={() => setCreateOpen(false)}>取消</Button>
              <Button type="submit" disabled={pending || running || !branchName.trim()}>{pending ? "创建中…" : "创建并切换"}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <GitGraphDialog open={graphOpen} projectPath={projectPath} onOpenChange={setGraphOpen} />
      {assist ? <GitSwitchAssistDialog projectPath={projectPath} target={assist.target} initialPreview={assist.preview} running={running} onClose={() => setAssist(null)} onChanged={() => { onChanged?.(); void load(); }} /> : null}
    </>
  );
}

export function DraftContextBar({ conversation, className = "mt-1.5" }: { conversation: Conversation; className?: string }) {
  const outsideProject = useAppStore((state) => state.projects.some((project) => project.path === conversation.projectPath && project.purpose === "conversation"));
  return (
    <div className={cn("flex min-w-0 items-center gap-1", className)}>
      <FolderPicker conversation={conversation} />
      {!outsideProject ? <BranchPicker key={conversation.projectPath} projectPath={conversation.projectPath} /> : null}
    </div>
  );
}
