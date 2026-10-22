import { useState, useSyncExternalStore, type ReactNode } from "react";
import { ChevronLeftIcon, ChevronRightIcon, PackageIcon } from "lucide-react";
import type { ModelSelectGroup } from "@/ModelConfigSelect.js";
import {
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu.js";

const query = "(max-width: 639px)";
function subscribe(listener: () => void) {
  const media = window.matchMedia(query);
  media.addEventListener("change", listener);
  return () => media.removeEventListener("change", listener);
}
const snapshot = () => window.matchMedia(query).matches;

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

/** 沿用 ZCode 的顶行子菜单；窄窗口在原弹窗内返回，避免子菜单越过窗口。 */
export function ComposerProviderMenu({
  groups,
  group,
  label,
  onSelect,
  children,
}: {
  groups: readonly ModelSelectGroup[];
  group?: ModelSelectGroup;
  label: string;
  onSelect?: (group: ModelSelectGroup) => void;
  children: ReactNode;
}) {
  const narrow = useSyncExternalStore(subscribe, snapshot, () => false);
  const [open, setOpen] = useState(false);
  const contents = (
    <DropdownMenuRadioGroup
      value={group?.key}
      className="min-h-0 overflow-y-auto overflow-x-hidden"
      data-composer-provider-list
    >
      {groups.map((candidate) => (
        <DropdownMenuRadioItem
          key={candidate.key}
          value={candidate.key}
          disabled={candidate.disabled}
          className="min-h-8 gap-2 pl-2 pr-8"
          data-model-provider-key={candidate.key}
          onSelect={(event) => {
            event.preventDefault();
            onSelect?.(candidate);
            setOpen(false);
          }}
        >
          <ProviderTitle group={candidate} />
          {candidate.disabled ? (
            <span className="text-ui-xs text-foreground-subtlest">未安装</span>
          ) : null}
        </DropdownMenuRadioItem>
      ))}
    </DropdownMenuRadioGroup>
  );
  const triggerProps = {
    "data-testid": "composer-provider-trigger",
    "aria-label": `${label}: ${group?.label ?? "—"}`,
    className:
      "min-h-8 gap-3 data-[highlighted]:bg-menu-hover/50 data-[state=open]:bg-menu-hover/50",
  };
  if (!onSelect)
    return (
      <>
        <div
          className="flex min-h-8 items-center px-2 py-1"
          aria-label={triggerProps["aria-label"]}
        >
          <ProviderTitle group={group} />
        </div>
        {children}
      </>
    );
  if (narrow)
    return open ? (
      <>
        <DropdownMenuItem
          data-testid="composer-provider-back"
          onSelect={(event) => {
            event.preventDefault();
            setOpen(false);
          }}
        >
          <ChevronLeftIcon className="size-4" />
          返回
        </DropdownMenuItem>
        <DropdownMenuSeparator className="shrink-0 bg-border/50" />
        {contents}
      </>
    ) : (
      <>
        <DropdownMenuItem
          {...triggerProps}
          onSelect={(event) => {
            event.preventDefault();
            setOpen(true);
          }}
        >
          <ProviderTitle group={group} />
          <ChevronRightIcon className="ml-auto size-4 text-foreground-subtle" />
        </DropdownMenuItem>
        {children}
      </>
    );
  return (
    <>
      <DropdownMenuSub open={open} onOpenChange={setOpen}>
        <DropdownMenuSubTrigger {...triggerProps}>
          <ProviderTitle group={group} />
        </DropdownMenuSubTrigger>
        <DropdownMenuPortal>
          <DropdownMenuSubContent
            sideOffset={9}
            alignOffset={-5}
            collisionPadding={12}
            className="z-[61] w-64 max-w-(--radix-dropdown-menu-content-available-width) max-h-(--radix-dropdown-menu-content-available-height) [app-region:no-drag]"
          >
            {contents}
          </DropdownMenuSubContent>
        </DropdownMenuPortal>
      </DropdownMenuSub>
      {children}
    </>
  );
}
