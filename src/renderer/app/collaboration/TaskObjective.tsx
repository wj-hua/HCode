// 执行视图先给出简短目标；完整用户目标和验收要求仍可展开，不改写原始记录。
import { collaborationInputTitle } from '@hcode/shared/collaborationPresentation';
export function TaskObjective({ objective }: { objective: string }) {
  const title = collaborationInputTitle(objective);
  if (title === objective) return <p className="mt-1 whitespace-pre-wrap text-foreground-subtle">{objective}</p>;
  return <details className="mt-1">
    <summary className="cursor-pointer text-foreground-subtle">{title}</summary>
    <p className="mt-2 text-ui-sm font-medium">完整任务与验收要求</p>
    <p className="mt-1 whitespace-pre-wrap text-foreground-subtle">{objective}</p>
  </details>;
}
