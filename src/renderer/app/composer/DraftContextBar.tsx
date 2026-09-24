// 新会话输入框下方的「文件夹 / 分支」选择：参照 ZCode ChatEmptyWorkspacePreviewMenu 与 GitBranchSwitcher。
import { ChevronDownIcon, FolderIcon, FolderPlusIcon, GitBranchIcon, LoaderIcon, SearchIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { GitBranches } from "@hcode/shared/types";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { toast } from "@/components/ui/toast.js";
import { hcode } from "../bridge";
import { shortenHome } from "../format";
import { errorMessage, useAppStore, type Conversation } from "../store/appStore";

function MenuSearch({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder: string }) {
  return (
    // 阻止按键冒泡，否则菜单的首字母跳转会抢走输入
    <div className="flex items-center gap-2 border-b border-border px-3 py-2" onKeyDown={(event) => event.stopPropagation()}>
      <SearchIcon className="size-4 shrink-0 text-foreground-subtlest" />
      <input
        autoFocus
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
  const [query, setQuery] = useState("");
  const name = conversation.projectPath.split("/").filter(Boolean).at(-1) ?? conversation.projectPath;
  const visible = projects.filter((project) => project.exists && matches(query, project.name, project.path));

  return (
    <DropdownMenu onOpenChange={(open) => !open && setQuery("")}>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className="min-w-0 max-w-60 gap-1.5 rounded-full text-foreground-subtle">
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
            打开文件夹…
          </DropdownMenuItem>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function BranchPicker({ projectPath }: { projectPath: string }) {
  // undefined = 读取中；null = 不是 git 仓库
  const [git, setGit] = useState<GitBranches | null | undefined>(undefined);
  const [pending, setPending] = useState(false);
  const [query, setQuery] = useState("");

  const load = useCallback(async () => {
    setGit(await hcode.invoke("git:branches", projectPath).catch(() => null));
  }, [projectPath]);

  useEffect(() => {
    setGit(undefined);
    void load();
  }, [load]);

  if (!git) return null;
  const visible = git.branches.filter((branch) => matches(query, branch));

  const switchTo = async (branch: string) => {
    if (branch === git.current) return;
    setPending(true);
    try {
      await hcode.invoke("git:switchBranch", projectPath, branch);
    } catch (error) {
      toast(`切换分支失败：${errorMessage(error)}`, { variant: "warning" });
    } finally {
      await load();
      setPending(false);
    }
  };

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        // 每次展开都重新读取，外部切过分支也能看到最新状态
        if (open) void load();
        else setQuery("");
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={pending}
          className="min-w-0 max-w-60 gap-1.5 rounded-full text-foreground-subtle"
        >
          <GitBranchIcon className="size-4 shrink-0" />
          <span className="truncate">{git.current ?? "分离的 HEAD"}</span>
          {pending ? <LoaderIcon className="size-3 shrink-0 animate-spin" /> : <ChevronDownIcon className="size-3 shrink-0" />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-72 p-0">
        <MenuSearch value={query} onChange={setQuery} placeholder="搜索分支" />
        <div className="max-h-64 overflow-y-auto p-1">
          <DropdownMenuLabel>分支</DropdownMenuLabel>
          {visible.map((branch) => (
            <DropdownMenuCheckboxItem
              key={branch}
              checked={branch === git.current}
              onSelect={() => void switchTo(branch)}
            >
              <span className="truncate">{branch}</span>
            </DropdownMenuCheckboxItem>
          ))}
          {visible.length === 0 ? <div className="px-2 py-2 text-ui-base text-foreground-subtlest">没有匹配的分支</div> : null}
        </div>
        <DropdownMenuSeparator className="my-0" />
        <div className="px-3 py-2 text-ui-sm text-foreground-subtlest">切换会直接在项目目录执行 git switch</div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function DraftContextBar({ conversation }: { conversation: Conversation }) {
  return (
    <div className="mt-1.5 flex min-w-0 items-center gap-1">
      <FolderPicker conversation={conversation} />
      <BranchPicker projectPath={conversation.projectPath} />
    </div>
  );
}
