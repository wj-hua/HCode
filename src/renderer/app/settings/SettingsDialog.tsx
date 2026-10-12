import { useEffect, useState } from "react";
import type { AgentKind, NotificationEvent, SettingsPatch } from "@hcode/shared/types";
import { isBackgroundVideo } from "@hcode/shared/types";
import { AGENT_KINDS, AGENTS } from "@hcode/shared/agents";
import { AgentBadge } from "../AgentBadge";
import { Button } from "@/components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog.js";
import { Switch } from "@/components/ui/switch.js";
import { cn } from "@/components/lib/utils.js";
import { useAppStore } from "../store/appStore";
import { hcode } from "../bridge";
import {
  isBuiltinSound,
  NOTIFICATION_EVENTS,
  NOTIFICATION_SOUND_OPTIONS,
  playNotificationSound,
} from "../notificationSound";
import { ExtensionsSection } from "./ExtensionsSection";
import {
  Palette,
  Bot,
  Bell,
  Boxes,
  Monitor,
  Sun,
  Moon,
  Code2,
  Briefcase,
  Globe,
  Sliders,
  Volume2,
  Play,
  FolderOpen,
  Trash2,
  Check,
  CheckCircle2,
  AlertCircle,
  Loader2,
  ChevronDown,
  Sparkles,
  Search,
  X,
  RotateCcw,
  Zap,
  RefreshCw,
} from "lucide-react";

type SettingsTab = "general" | "agents" | "notifications" | "extensions";

interface NavItem {
  id: SettingsTab;
  label: string;
  desc: string;
  icon: React.ComponentType<{ className?: string }>;
}

const NAV_ITEMS: NavItem[] = [
  { id: "general", label: "常规与外观", desc: "主题、语言与个性化背景", icon: Palette },
  { id: "agents", label: "模型与 CLI", desc: "默认 CLI、模型与权限", icon: Bot },
  { id: "notifications", label: "通知与系统", desc: "休眠策略与提示音", icon: Bell },
  { id: "extensions", label: "MCP 与技能", desc: "上下文扩展与技能工具", icon: Boxes },
];

const TAB_KEYWORDS: Record<SettingsTab, string[]> = {
  general: ["常规", "外观", "主题", "浅色", "深色", "暗色", "模式", "编程", "办公", "语言", "中文", "英文", "壁纸", "背景", "模糊", "蒙层", "theme", "wallpaper", "blur"],
  agents: ["模型", "cli", "agent", "claude", "codex", "antigravity", "gemini", "cline", "权限", "路径", "版本", "思考", "effort", "model", "path"],
  notifications: ["通知", "系统", "休眠", "睡眠", "声音", "提示音", "潇", "试听", "音频", "静音", "sound", "notify", "sleep"],
  extensions: ["mcp", "技能", "skill", "扩展", "服务器", "stdio", "http", "tool", "插件"],
};

function CardGroup({
  title,
  subtitle,
  extra,
  children,
  className,
}: {
  title?: string;
  subtitle?: string;
  extra?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {(title || subtitle || extra) && (
        <div className="flex items-end justify-between px-1">
          <div className="flex flex-col gap-0.5">
            {title && <h3 className="text-ui-base font-semibold text-foreground">{title}</h3>}
            {subtitle && <p className="text-ui-xs text-foreground-subtle">{subtitle}</p>}
          </div>
          {extra}
        </div>
      )}
      <div className="overflow-hidden rounded-xl border border-border/70 bg-card/40 shadow-2xs divide-y divide-border/50">
        {children}
      </div>
    </div>
  );
}

function SettingRow({
  label,
  hint,
  badge,
  children,
  className,
}: {
  label: string;
  hint?: string;
  badge?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center justify-between gap-6 px-4 py-3.5", className)}>
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <span className="text-ui-base font-medium text-foreground">{label}</span>
          {badge}
        </div>
        {hint && <span className="text-ui-sm text-foreground-subtle leading-relaxed">{hint}</span>}
      </div>
      {children && <div className="shrink-0 flex items-center gap-2">{children}</div>}
    </div>
  );
}

function ToggleRow({
  label,
  hint,
  checked,
  onChange,
  className,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center justify-between gap-6 px-4 py-3.5", className)}>
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-ui-base font-medium text-foreground">{label}</span>
        {hint && <span className="text-ui-sm text-foreground-subtle leading-relaxed">{hint}</span>}
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
  className,
}: {
  value: T;
  options: { value: T; label: string; icon?: React.ComponentType<{ className?: string }> }[];
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <div className={cn("inline-flex rounded-lg border border-border/80 bg-surface/60 p-0.5 shadow-2xs", className)}>
      {options.map((option) => {
        const Icon = option.icon;
        const isSelected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-ui-base transition-all cursor-pointer",
              isSelected
                ? "bg-background text-foreground shadow-xs font-medium"
                : "text-foreground-subtle hover:text-foreground hover:bg-surface-hover/50",
            )}
          >
            {Icon && <Icon className="size-3.5 shrink-0" />}
            <span>{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function StyledSelect({
  value,
  onChange,
  children,
  className,
  disabled,
}: {
  value: string;
  onChange: (val: string) => void;
  children: React.ReactNode;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <div className={cn("relative inline-block", className)}>
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 w-full appearance-none rounded-lg border border-input-border bg-input pl-3 pr-8 text-ui-base text-foreground transition-colors hover:border-input-border-hover focus:border-input-border-focused focus:bg-input-focused outline-none disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 size-3.5 text-foreground-subtle" />
    </div>
  );
}

function GeneralTab() {
  const settings = useAppStore((state) => state.settings);
  const updateSettings = useAppStore((state) => state.updateSettings);
  const background = settings.background;

  const update = (patch: SettingsPatch) => void updateSettings(patch);
  const updateBackground = (patch: Partial<typeof background>) =>
    void updateSettings({ background: { ...background, ...patch } });

  const pickBackground = async () => {
    const path = await hcode.invoke("app:pickBackground");
    if (path) updateBackground({ path });
  };

  const sliders = [
    { key: "blur" as const, label: "背景模糊", max: 60, unit: "px" },
    { key: "mask" as const, label: "蒙层浓度", max: 100, unit: "%" },
  ];

  return (
    <div className="flex flex-col gap-6">
      {/* 主题选择卡片 */}
      <CardGroup title="界面主题" subtitle="选择应用程序的色彩与明暗风格">
        <div className="grid grid-cols-3 gap-3 p-4">
          {[
            { value: "system" as const, label: "跟随系统", desc: "自动匹配操作系统外观", icon: Monitor },
            { value: "light" as const, label: "浅色模式", desc: "明亮清晰的标准视觉", icon: Sun },
            { value: "dark" as const, label: "深色模式", desc: "沉浸专注的暗色视觉", icon: Moon },
          ].map((item) => {
            const Icon = item.icon;
            const isSelected = settings.theme === item.value;
            return (
              <button
                key={item.value}
                type="button"
                onClick={() => update({ theme: item.value })}
                className={cn(
                  "group relative flex flex-col items-center gap-2 rounded-xl border p-3.5 text-center transition-all cursor-pointer",
                  isSelected
                    ? "border-primary bg-primary/5 shadow-xs ring-1 ring-primary/30 text-foreground"
                    : "border-border/70 bg-surface/20 text-foreground-subtle hover:border-border hover:bg-surface-hover/50 hover:text-foreground",
                )}
              >
                <div
                  className={cn(
                    "flex size-9 items-center justify-center rounded-lg border transition-colors",
                    isSelected
                      ? "border-primary/30 bg-primary/10 text-primary"
                      : "border-border/60 bg-surface text-foreground-subtle group-hover:text-foreground",
                  )}
                >
                  <Icon className="size-4.5" />
                </div>
                <div className="flex flex-col gap-0.5">
                  <span className="text-ui-base font-medium">{item.label}</span>
                  <span className="text-ui-xs text-foreground-subtle leading-tight">{item.desc}</span>
                </div>
                {isSelected && (
                  <div className="absolute top-2 right-2 flex size-4 items-center justify-center rounded-full bg-primary text-primary-foreground">
                    <Check className="size-2.5 stroke-[3]" />
                  </div>
                )}
              </button>
            );
          })}
        </div>
      </CardGroup>

      {/* 界面模式选择卡片 */}
      <CardGroup title="界面工作模式" subtitle="针对不同工作流切换界面信息密度与终端输出侧重点">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 p-4">
          {[
            {
              value: "coding" as const,
              label: "编程模式",
              badge: "推荐开发使用",
              desc: "显示完整的终端命令、工具调用细节与代码 Diff 变动详情，适合工程开发与代码构建",
              icon: Code2,
            },
            {
              value: "office" as const,
              label: "办公模式",
              badge: "聚焦任务交付",
              desc: "以高层级任务摘要与交付成果为主，折叠繁琐的终端技术输出，界面更轻量整洁",
              icon: Briefcase,
            },
          ].map((item) => {
            const Icon = item.icon;
            const isSelected = settings.interfaceMode === item.value;
            return (
              <button
                key={item.value}
                type="button"
                onClick={() => update({ interfaceMode: item.value })}
                className={cn(
                  "group relative flex flex-col items-start gap-2.5 rounded-xl border p-4 text-left transition-all cursor-pointer",
                  isSelected
                    ? "border-primary bg-primary/5 shadow-xs ring-1 ring-primary/30 text-foreground"
                    : "border-border/70 bg-surface/20 text-foreground-subtle hover:border-border hover:bg-surface-hover/50 hover:text-foreground",
                )}
              >
                <div className="flex w-full items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div
                      className={cn(
                        "flex size-7 items-center justify-center rounded-md border transition-colors",
                        isSelected
                          ? "border-primary/30 bg-primary/10 text-primary"
                          : "border-border/60 bg-surface text-foreground-subtle group-hover:text-foreground",
                      )}
                    >
                      <Icon className="size-4" />
                    </div>
                    <span className="text-ui-base font-semibold text-foreground">{item.label}</span>
                    <span className="rounded-full bg-surface border border-border/60 px-1.5 py-0.5 text-ui-xs text-foreground-subtle">
                      {item.badge}
                    </span>
                  </div>
                  {isSelected && (
                    <div className="flex size-4 items-center justify-center rounded-full bg-primary text-primary-foreground">
                      <Check className="size-2.5 stroke-[3]" />
                    </div>
                  )}
                </div>
                <p className="text-ui-sm text-foreground-subtle leading-relaxed">{item.desc}</p>
              </button>
            );
          })}
        </div>
      </CardGroup>

      {/* 语言与壁纸 */}
      <CardGroup title="个性化与环境" subtitle="语言首选项与应用背景视觉">
        <SettingRow label="界面语言" hint="影响卡片、通知与系统内置文案的展示语言">
          <Segmented
            value={settings.locale}
            options={[
              { value: "zh-CN", label: "中文", icon: Globe },
              { value: "en-US", label: "English", icon: Globe },
            ]}
            onChange={(locale) => update({ locale })}
          />
        </SettingRow>

        <SettingRow
          label="自定义壁纸"
          badge={
            background.path ? (
              <span className="rounded bg-surface px-1.5 py-0.5 text-ui-xs text-foreground-subtle border border-border/60">
                {isBackgroundVideo(background.path) ? "动态视频" : "静态图片"}
              </span>
            ) : undefined
          }
          hint={
            background.path
              ? `已启用：${background.path.split("/").at(-1)}`
              : "支持图片与视频背景（视频将静音循环播放）"
          }
        >
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => void pickBackground()}>
              <FolderOpen className="size-3.5 mr-1 text-foreground-subtle" />
              {background.path ? "更换壁纸" : "选择文件"}
            </Button>
            {background.path && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => updateBackground({ path: "" })}
                className="text-destructive hover:bg-destructive/10"
              >
                <Trash2 className="size-3.5 mr-1" />
                清除
              </Button>
            )}
          </div>
        </SettingRow>

        {background.path && (
          <div className="flex flex-col gap-3 bg-surface/30 px-4 py-3.5 border-t border-border/40">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5 text-ui-xs font-medium text-foreground-subtle">
                <Sliders className="size-3.5" />
                <span>壁纸视觉特效微调</span>
              </div>
              <span className="text-ui-xs text-foreground-subtle/80">调节背景毛玻璃质感与界面对比度</span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {sliders.map(({ key, label, max, unit }) => (
                <div key={key} className="flex flex-col gap-1.5 rounded-lg border border-border/50 bg-background/50 p-2.5">
                  <div className="flex items-center justify-between text-ui-sm">
                    <span className="text-foreground">{label}</span>
                    <span className="font-mono text-ui-xs text-foreground-subtle tabular-nums font-semibold">
                      {background[key]}
                      {unit}
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={max}
                    value={background[key]}
                    onChange={(event) => updateBackground({ [key]: Number(event.target.value) })}
                    className="h-1.5 w-full cursor-pointer appearance-none rounded-lg bg-surface-hover accent-primary"
                  />
                </div>
              ))}
            </div>
          </div>
        )}
      </CardGroup>
    </div>
  );
}

function AgentSection({ kind }: { kind: AgentKind }) {
  const settings = useAppStore((state) => state.settings);
  const updateSettings = useAppStore((state) => state.updateSettings);
  const status = useAppStore((state) => state.agentStatuses?.find((item) => item.kind === kind));
  const models = useAppStore((state) => state.models[kind]) ?? AGENTS[kind].models;
  const loadModels = useAppStore((state) => state.loadModels);
  const modelError = useAppStore((state) => state.modelErrors[kind]);
  const modelsLoading = useAppStore((state) => state.modelsLoading[kind]);
  const open = useAppStore((state) => state.settingsOpen);
  const [path, setPath] = useState(settings.agentPaths[kind]);
  const [saved, setSaved] = useState(false);
  const agent = AGENTS[kind];

  useEffect(() => {
    if (open) {
      setPath(settings.agentPaths[kind]);
      void loadModels(kind);
    }
  }, [open, kind, settings.agentPaths, loadModels]);

  const handleSave = async () => {
    await updateSettings({ agentPaths: { [kind]: path.trim() } });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleResetPath = async () => {
    setPath("");
    await updateSettings({ agentPaths: { [kind]: "" } });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="rounded-xl border border-border/70 bg-card/40 p-4 transition-all hover:border-border flex flex-col gap-4 shadow-2xs">
      {/* 头部：Badge、名称、命令行、状态标签 */}
      <div className="flex items-center justify-between gap-3 border-b border-border/50 pb-3">
        <div className="flex items-center gap-2.5">
          <AgentBadge agent={kind} className={cn("size-5", status?.found === false && "opacity-40")} />
          <span className="text-ui-base font-semibold text-foreground">{agent.name}</span>
          <span className="rounded bg-surface px-1.5 py-0.5 font-mono text-ui-xs text-foreground-subtle border border-border/60">
            {agent.command}
          </span>
        </div>
        <div>
          {!status ? (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-border/50 bg-surface px-2.5 py-0.5 text-ui-xs text-foreground-subtle">
              <Loader2 className="size-3 animate-spin text-foreground-subtle" />
              正在检测…
            </span>
          ) : status.found ? (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2.5 py-0.5 text-ui-xs font-medium text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="size-3" />
              {status.version ? `版本 ${status.version}` : "已安装"}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-surface px-2.5 py-0.5 text-ui-xs text-foreground-subtle">
              <AlertCircle className="size-3 text-foreground-subtle" />
              未安装 / 环境变量未找到
            </span>
          )}
        </div>
      </div>

      {/* 默认权限模式 & 默认模型两列 */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="flex flex-col gap-1.5">
          <label className="text-ui-sm font-medium text-foreground">默认权限模式</label>
          <StyledSelect
            value={settings.defaultPermissionModes[kind]}
            onChange={(val) => void updateSettings({ defaultPermissionModes: { [kind]: val } })}
            className="w-full"
          >
            {agent.permissionModes.map((item) => (
              <option key={item.mode} value={item.mode}>
                {item.label} {item.dangerous ? "(⚠️ 放行)" : ""}
              </option>
            ))}
          </StyledSelect>
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-ui-sm font-medium text-foreground">默认模型</label>
          <StyledSelect
            value={settings.defaultModels[kind]}
            onChange={(val) => void updateSettings({ defaultModels: { [kind]: val } })}
            className="w-full"
          >
            {models.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </StyledSelect>
          {modelError && <p className="text-ui-xs text-destructive">{modelError}</p>}
          <button type="button" onClick={() => void loadModels(kind, true)} disabled={modelsLoading} className="flex items-center gap-1 self-start text-ui-xs text-foreground-subtle hover:text-foreground disabled:opacity-50">
            <RefreshCw className={cn("size-3", modelsLoading && "animate-spin")} />
            {modelsLoading ? "正在读取模型…" : modelError ? "重试读取模型" : "刷新模型列表"}
          </button>
        </div>

        {/* 若为 Claude Code，展示默认思考强度 (Effort) */}
        {kind === "claude" && (
          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <div className="flex items-center gap-1.5">
              <Zap className="size-3.5 text-amber-500" />
              <label className="text-ui-sm font-medium text-foreground">默认思考强度 (Thinking Effort)</label>
            </div>
            <StyledSelect
              value={settings.defaultEfforts[kind] || ""}
              onChange={(val) => void updateSettings({ defaultEfforts: { [kind]: val } })}
              className="w-full"
            >
              <option value="">CLI 默认（自适应）</option>
              <option value="low">低 (low) - 极速响应，耗费额度最少</option>
              <option value="medium">中 (medium) - 日常编码推荐</option>
              <option value="high">高 (high) - 深度架构推演</option>
              <option value="xhigh">极高 (xhigh) - 复杂疑难排查</option>
              <option value="max">极致 (max) - 最大思考预算</option>
            </StyledSelect>
          </div>
        )}
      </div>

      {/* 可执行文件路径配置 */}
      <div className="flex flex-col gap-1.5 pt-1">
        <div className="flex items-center justify-between text-ui-xs text-foreground-subtle">
          <span>可执行文件路径（留空将从系统 PATH 自动检测）</span>
          <span className="truncate max-w-[280px]" title={status?.found ? status.path : "未找到"}>
            当前：{status?.found ? status.path : "未找到"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <input
            value={path}
            onChange={(event) => setPath(event.target.value)}
            placeholder={`例如 /usr/local/bin/${agent.command}`}
            className="h-8 min-w-0 flex-1 rounded-lg border border-input-border bg-input px-2.5 font-mono text-ui-xs text-foreground outline-none transition-colors hover:border-input-border-hover focus:border-input-border-focused"
          />
          {path && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleResetPath}
              className="text-foreground-subtle hover:text-foreground"
              title="清空并恢复自动寻径"
            >
              <RotateCcw className="size-3.5 mr-1" />
              重置
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={handleSave}
            className={saved ? "border-emerald-500/50 text-emerald-600 dark:text-emerald-400" : ""}
          >
            {saved ? (
              <>
                <Check className="size-3.5 mr-1 text-emerald-600 dark:text-emerald-400" />
                已保存
              </>
            ) : (
              "保存并检测"
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}

function AgentsTab() {
  const settings = useAppStore((state) => state.settings);
  const updateSettings = useAppStore((state) => state.updateSettings);
  const [detectingAll, setDetectingAll] = useState(false);

  const handleDetectAll = async () => {
    setDetectingAll(true);
    try {
      const statuses = await hcode.invoke("agent:status");
      useAppStore.setState({ agentStatuses: statuses });
    } finally {
      setDetectingAll(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      {/* 默认 CLI 选择卡片 */}
      <CardGroup
        title="新建会话默认 CLI"
        subtitle="快速创建新会话或运行后台任务时优先选用的智能体引擎"
      >
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 p-4">
          {AGENT_KINDS.map((kind) => {
            const isSelected = settings.defaultAgent === kind;
            return (
              <button
                key={kind}
                type="button"
                onClick={() => void updateSettings({ defaultAgent: kind })}
                className={cn(
                  "group relative flex flex-col items-center gap-2 rounded-xl border p-3 transition-all cursor-pointer text-center",
                  isSelected
                    ? "border-primary bg-primary/5 shadow-xs ring-1 ring-primary/30 text-foreground font-semibold"
                    : "border-border/60 bg-surface/20 text-foreground-subtle hover:border-border hover:bg-surface-hover/50 hover:text-foreground",
                )}
              >
                <AgentBadge agent={kind} className="size-6 transition-transform group-hover:scale-105" />
                <span className="text-ui-sm truncate w-full">{AGENTS[kind].name}</span>
                {isSelected && (
                  <div className="absolute top-1.5 right-1.5 flex size-3.5 items-center justify-center rounded-full bg-primary text-primary-foreground">
                    <Check className="size-2 stroke-[3]" />
                  </div>
                )}
              </button>
            );
          })}
        </div>
      </CardGroup>

      {/* 各 Agent 独立详细卡片 */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between px-1">
          <div>
            <h3 className="text-ui-base font-semibold text-foreground">智能体独立配置</h3>
            <p className="text-ui-xs text-foreground-subtle">
              针对各命令行工具独立配置调用权限、默认启动模型以及可执行文件路径
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={detectingAll}
            onClick={handleDetectAll}
            className="shrink-0"
          >
            <RefreshCw className={cn("size-3.5 mr-1.5", detectingAll && "animate-spin")} />
            {detectingAll ? "检测中…" : "刷新全部检测"}
          </Button>
        </div>
        <div className="flex flex-col gap-4">
          {AGENT_KINDS.map((kind) => (
            <AgentSection key={kind} kind={kind} />
          ))}
        </div>
      </div>
    </div>
  );
}

function NotificationsTab() {
  const settings = useAppStore((state) => state.settings);
  const updateSettings = useAppStore((state) => state.updateSettings);
  const sound = settings.notificationSound;
  const [playingEvent, setPlayingEvent] = useState<NotificationEvent | null>(null);

  const update = (patch: SettingsPatch) => void updateSettings(patch);

  const handlePlay = async (event: NotificationEvent) => {
    setPlayingEvent(event);
    try {
      await playNotificationSound(settings, event);
    } finally {
      setTimeout(() => setPlayingEvent(null), 1000);
    }
  };

  const pickCustom = async (event: NotificationEvent) => {
    const path = await hcode.invoke("app:pickAudio");
    if (path) await updateSettings({ customSounds: { ...settings.customSounds, [event]: path } });
  };

  return (
    <div className="flex flex-col gap-6">
      {/* 系统策略卡片 */}
      <CardGroup title="系统策略" subtitle="长时间任务执行时的硬件唤醒与后台调度">
        <ToggleRow
          label="运行任务时阻止休眠"
          hint="当有代码会话正在执行后台任务时，保持系统唤醒，防止网络连接中断或执行停滞"
          checked={settings.preventSleepWhileRunning}
          onChange={(preventSleepWhileRunning) => update({ preventSleepWhileRunning })}
        />
        <ToggleRow
          label="桌面系统通知"
          hint="HCode 处于后台时，任务启动、执行完毕、运行报错或需手动审批时发送桌面弹窗"
          checked={settings.notifyOnFinish}
          onChange={(notifyOnFinish) => update({ notifyOnFinish })}
        />
      </CardGroup>

      {/* 通知音效卡片 */}
      {settings.notifyOnFinish && (
        <CardGroup title="声音与提示" subtitle="配置事件通知的音频方案与各事件专属提示音">
          <SettingRow label="提示音方案" hint="内置语音为潇潇男声；也可使用系统默认声或自定义音频">
            <Segmented
              value={sound}
              options={NOTIFICATION_SOUND_OPTIONS}
              onChange={(notificationSound) => void updateSettings({ notificationSound })}
            />
          </SettingRow>

          {isBuiltinSound(sound) && (
            <div className="flex flex-col divide-y divide-border/50 bg-surface/20">
              {NOTIFICATION_EVENTS.map(({ value: event, label }) => (
                <div key={event} className="flex items-center justify-between px-4 py-3">
                  <div className="flex items-center gap-2">
                    <Volume2 className="size-4 text-foreground-subtle" />
                    <span className="text-ui-base text-foreground font-medium">{label}</span>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={playingEvent === event}
                    onClick={() => void handlePlay(event)}
                  >
                    <Play className={cn("size-3.5 mr-1 text-foreground-subtle", playingEvent === event && "text-primary animate-pulse")} />
                    {playingEvent === event ? "正在播放…" : "试听"}
                  </Button>
                </div>
              ))}
            </div>
          )}

          {sound === "custom" && (
            <div className="flex flex-col divide-y divide-border/50 bg-surface/20">
              {NOTIFICATION_EVENTS.map(({ value: event, label }) => {
                const path = settings.customSounds[event];
                return (
                  <div key={event} className="flex items-center justify-between gap-4 px-4 py-3">
                    <div className="flex min-w-0 flex-col">
                      <span className="text-ui-base font-medium text-foreground">{label}</span>
                      <span className="text-ui-xs text-foreground-subtle truncate max-w-[280px]">
                        {path ? path.split("/").at(-1) : "未设置（沿用系统提示音）"}
                      </span>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Button variant="outline" size="sm" onClick={() => void pickCustom(event)}>
                        <FolderOpen className="size-3.5 mr-1 text-foreground-subtle" />
                        选择文件
                      </Button>
                      {path && (
                        <>
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={playingEvent === event}
                            onClick={() => void handlePlay(event)}
                          >
                            <Play className={cn("size-3.5 mr-1 text-foreground-subtle", playingEvent === event && "text-primary animate-pulse")} />
                            {playingEvent === event ? "正在播放…" : "试听"}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              void updateSettings({ customSounds: { ...settings.customSounds, [event]: "" } })
                            }
                            className="text-destructive hover:bg-destructive/10"
                          >
                            <Trash2 className="size-3.5" />
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardGroup>
      )}
    </div>
  );
}

export function SettingsDialog() {
  const open = useAppStore((state) => state.settingsOpen);
  const setOpen = useAppStore((state) => state.setSettingsOpen);
  const storeTab = useAppStore((state) => state.settingsTab);
  const [tab, setTab] = useState<SettingsTab>(storeTab || "general");
  const [searchQuery, setSearchQuery] = useState("");

  useEffect(() => {
    if (open && storeTab) setTab(storeTab);
  }, [open, storeTab]);

  const matchesTab = (tabId: SettingsTab) => {
    if (!searchQuery.trim()) return true;
    const lower = searchQuery.trim().toLowerCase();
    return TAB_KEYWORDS[tabId]?.some((kw) => kw.includes(lower) || lower.includes(kw));
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="flex h-[min(740px,90vh)] w-[calc(100vw-3rem)] max-w-4xl min-w-0 flex-col gap-0 p-0 overflow-hidden rounded-2xl border border-border bg-background shadow-2xl">
        {/* 对话框顶栏 */}
        <DialogHeader className="flex flex-row items-center justify-between border-b border-border/70 px-6 py-4 shrink-0 bg-surface/20">
          <div className="flex items-center gap-3">
            <div className="flex size-9 items-center justify-center rounded-xl border border-border/80 bg-surface shadow-2xs">
              <Sparkles className="size-4.5 text-primary" />
            </div>
            <div className="flex flex-col">
              <DialogTitle className="text-base font-semibold text-foreground">偏好设置</DialogTitle>
              <DialogDescription className="text-ui-xs text-foreground-subtle">
                定制 HCode 的界面外观、CLI 智能体运行模式与 MCP 扩展生态
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {/* 主体两栏布局：左侧导航 + 右侧内容 */}
        <div className="flex flex-1 min-h-0 overflow-hidden">
          {/* 左侧垂直导航栏 */}
          <nav className="w-52 shrink-0 border-r border-border/60 bg-surface/30 p-3 flex flex-col justify-between select-none">
            <div className="flex flex-col gap-2">
              {/* 搜索框 */}
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-foreground-subtle" />
                <input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="搜索设置项..."
                  className="h-8 w-full rounded-lg border border-input-border bg-input pl-8 pr-7 text-ui-xs text-foreground outline-none transition-colors hover:border-input-border-hover focus:border-input-border-focused"
                />
                {searchQuery && (
                  <button
                    type="button"
                    onClick={() => setSearchQuery("")}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-foreground-subtle hover:text-foreground cursor-pointer"
                  >
                    <X className="size-3" />
                  </button>
                )}
              </div>

              {/* 导航按钮列表 */}
              <div className="flex flex-col gap-1 pt-1">
                {NAV_ITEMS.map((item) => {
                  const Icon = item.icon;
                  const active = tab === item.id;
                  const isMatch = matchesTab(item.id);
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setTab(item.id)}
                      className={cn(
                        "flex items-center justify-between rounded-xl px-3 py-2.5 text-ui-base transition-all text-left cursor-pointer",
                        active
                          ? "bg-primary text-primary-foreground font-semibold shadow-2xs"
                          : "text-foreground-subtle hover:bg-surface-hover hover:text-foreground font-medium",
                        !isMatch && searchQuery.trim() && "opacity-40",
                      )}
                    >
                      <div className="flex items-center gap-3">
                        <Icon className="size-4 shrink-0" />
                        <span>{item.label}</span>
                      </div>
                      {searchQuery.trim() && isMatch && (
                        <span className="size-1.5 rounded-full bg-emerald-500 shrink-0" />
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="px-3 py-2 text-ui-xs text-foreground-subtle/70 border-t border-border/40 flex items-center justify-between">
              <span>HCode Desktop</span>
              <span className="font-mono">v0.19.6</span>
            </div>
          </nav>

          {/* 右侧设置主面板 */}
          <main className="flex-1 min-w-0 overflow-y-auto px-7 py-6">
            {tab === "general" && <GeneralTab />}
            {tab === "agents" && <AgentsTab />}
            {tab === "notifications" && <NotificationsTab />}
            {tab === "extensions" && <ExtensionsSection open={open} />}
          </main>
        </div>
      </DialogContent>
    </Dialog>
  );
}
