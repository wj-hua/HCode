// 展示实际导入方式、来源版本及阶段冲突；不把配置加载标为专业效果已验证。
import type {
  ExpertProfilePreview,
  ExpertProfileSnapshot,
  ExpertResourceRead,
  ExpertProfileLoad,
} from "@hcode/shared/expertProfiles";
export function ExpertProfileDetails({
  profile,
  loads,
  reads,
}: {
  profile: ExpertProfileSnapshot | ExpertProfilePreview;
  loads?: ExpertProfileLoad[];
  reads?: ExpertResourceRead[];
}) {
  return (
    <details className="mt-2 text-ui-sm">
      <summary className="cursor-pointer">
        组合角色与 Skills · 指令加载 · {profile.roles.length} 角色 /{" "}
        {profile.skills.length} Skills
      </summary>
      <p className="mt-2 break-all">配置 SHA-256：{profile.hash}</p>
      <p>只读研究与审查均加载完整主文件；注入记录不代表方法效果已验证。</p>
      {[
        ...profile.roles.map((ref) => ({ ...ref, kind: "角色" })),
        ...profile.skills.map((ref) => ({ ...ref, kind: "Skill" })),
      ].map((ref) => (
        <div key={`${ref.kind}/${ref.sourcePath}`} className="mt-2 break-all">
          <p>
            {ref.kind}：{ref.name}
          </p>
          <p className="text-foreground-subtle">
            {ref.sourcePath}
            <br />
            SHA-256：{ref.hash}
          </p>
        </div>
      ))}
      <p className="mt-2">
        关联文本资源已冻结 {profile.resources.length} 项；脚本只读，不执行。
      </p>
      <ul className="mt-2 list-disc pl-5">
        {profile.limitations.map((text, index) => (
          <li key={index}>{text}</li>
        ))}
      </ul>
      {"issues" in profile && profile.issues.length ? (
        <p role="alert" className="mt-2 whitespace-pre-wrap text-destructive">
          {profile.issues.join("\n")}
        </p>
      ) : null}
      {loads ? (
        <p className="mt-2">
          实际指令加载：独立研究{" "}
          {loads.filter((load) => load.stage === "research").length} 次 / 互审{" "}
          {loads.filter((load) => load.stage === "review").length} 次
        </p>
      ) : null}
      {reads?.length ? (
        <ul className="mt-2 list-disc pl-5">
          {reads.map((read, index) => (
            <li key={index} className="break-all">
              实际读取：{read.stage} · {read.skill}/{read.path} · {read.hash}
            </li>
          ))}
        </ul>
      ) : null}
    </details>
  );
}
