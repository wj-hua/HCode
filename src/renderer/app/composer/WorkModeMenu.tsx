// 统一工作方式入口；选择方式只更新界面，协作分工与专家团队分别在各自面板配置。
import { ChevronDownIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuLabel } from "@/components/ui/dropdown-menu.js";
import { WORK_MODES, type WorkMode } from "./workMode";

export function WorkModeMenu({ mode, onMode, onClose }: {
  mode: WorkMode; onMode(mode: WorkMode): void; onClose(event: Event): void;
}) {
  return <DropdownMenu>
    <DropdownMenuTrigger asChild><Button type="button" variant="ghost" size="sm" aria-label={`工作方式：${WORK_MODES[mode].label}`} className="h-7 gap-1 rounded-lg px-2 text-ui-base focus-visible:ring-2 focus-visible:ring-ring active:brightness-90">{WORK_MODES[mode].label}<ChevronDownIcon className="size-3.5" /></Button></DropdownMenuTrigger>
    <DropdownMenuContent side="top" align="start" className="w-80" onCloseAutoFocus={onClose}>
      <DropdownMenuLabel>工作方式</DropdownMenuLabel>
      <DropdownMenuRadioGroup value={mode} onValueChange={value => onMode(value as WorkMode)}>
        {Object.entries(WORK_MODES).map(([value, entry]) => <DropdownMenuRadioItem key={value} value={value} className="items-start py-2"><span className="flex flex-col gap-1"><span>{entry.label}</span><span className="text-ui-sm text-foreground-subtle">{entry.description}</span></span></DropdownMenuRadioItem>)}
      </DropdownMenuRadioGroup>
    </DropdownMenuContent>
  </DropdownMenu>;
}
