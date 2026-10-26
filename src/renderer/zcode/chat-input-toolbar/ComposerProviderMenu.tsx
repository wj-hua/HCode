import { useEffect } from "react";
import { PackageIcon } from "lucide-react";
import type { ModelSelectGroup } from "@/ModelConfigSelect.js";
import {
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@/components/ui/dropdown-menu.js";

function ProviderTitle({ group }: { group?: ModelSelectGroup }) {
  return (
    <span className="flex min-w-0 flex-1 items-center gap-1.5">
      {group?.icon ?? <PackageIcon className="size-4" />}
      <span className="truncate">{group?.label ?? "—"}</span>
      {group?.labelBadge ? (
        <span className="shrink-0 rounded-full bg-surface px-1 py-px text-ui-xs font-medium leading-normal text-foreground-subtle">
          {group.labelBadge}
        </span>
      ) : null}
    </span>
  );
}

/** 弹窗向上展开，CLI 放在底部靠近触发器；横排标签一次点击切换，不再经过子菜单。 */
export function ComposerProviderMenu({
  groups,
  group,
  label,
  onSelect,
}: {
  groups: readonly ModelSelectGroup[];
  group?: ModelSelectGroup;
  label: string;
  onSelect?: (group: ModelSelectGroup) => void;
}) {
  useEffect(() => {
    if (!onSelect) return;
    // 菜单打开时才挂载；数字键按顺序直选 CLI，捕获阶段拦截以免触发 Radix 的首字母跳转。
    const selectByDigit = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey
      )
        return;
      const target = event.target;
      if (
        !(target instanceof HTMLElement) ||
        !target.closest("[data-composer-model-menu]")
      )
        return;
      const candidate = /^[1-9]$/.test(event.key)
        ? groups[Number(event.key) - 1]
        : undefined;
      if (!candidate) return;
      event.preventDefault();
      event.stopPropagation();
      if (!candidate.disabled && candidate.key !== group?.key)
        onSelect(candidate);
    };
    window.addEventListener("keydown", selectByDigit, true);
    return () => window.removeEventListener("keydown", selectByDigit, true);
  }, [groups, group?.key, onSelect]);

  if (!onSelect)
    return (
      <div
        className="flex min-h-8 items-center px-2 py-1"
        aria-label={`${label}: ${group?.label ?? "—"}`}
      >
        <ProviderTitle group={group} />
      </div>
    );
  return (
    <div className="px-1 pt-1 pb-0.5">
      <div className="mb-1 flex items-center gap-2 px-1">
        <span className="text-ui-sm text-foreground-subtle">{label}</span>
        {groups.length > 1 ? (
          <kbd className="ml-auto rounded-full bg-surface px-2 text-ui-xs text-foreground-subtle">
            1–{Math.min(groups.length, 9)}
          </kbd>
        ) : null}
      </div>
      <DropdownMenuRadioGroup
        value={group?.key}
        aria-label={label}
        className="flex flex-row gap-1"
      >
        {groups.map((candidate, index) => (
          <DropdownMenuRadioItem
            key={candidate.key}
            value={candidate.key}
            disabled={candidate.disabled}
            aria-label={candidate.label}
            title={
              candidate.disabled
                ? `${candidate.label}（未安装）`
                : index < 9
                  ? `${candidate.label}（${index + 1}）`
                  : candidate.label
            }
            className="h-8 min-w-0 flex-1 justify-center rounded-lg px-2 text-ui-sm data-[state=checked]:bg-menu-hover/70 data-[state=checked]:font-medium data-disabled:opacity-40 [&>[data-slot=dropdown-menu-radio-item-indicator]]:hidden [&_svg]:size-4.5"
            data-model-provider-key={candidate.key}
            onSelect={(event) => {
              // 保持菜单打开，切换 CLI 后通常还要接着选模型。
              event.preventDefault();
              if (candidate.key !== group?.key) onSelect(candidate);
            }}
          >
            {candidate.icon ?? <PackageIcon className="size-4" />}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
    </div>
  );
}
