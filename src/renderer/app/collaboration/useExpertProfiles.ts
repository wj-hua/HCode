// 当前项目的本机专家配置预览与确认；失败可重试，刷新不改变已运行的冻结配置。
import { useCallback, useEffect, useState } from "react";
import type { ExpertProfilePreview } from "@hcode/shared/expertProfiles";
import { hcode } from "../bridge";
export function useExpertProfiles(project: string, enabled: boolean) {
  const [profiles, setProfiles] = useState<ExpertProfilePreview[]>(),
    [error, setError] = useState(""),
    [accepted, setAccepted] = useState(false),
    [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    setProfiles(undefined);
    setError("");
    setAccepted(false);
    const load = async () => {
      try {
        const result = await hcode.invoke(
          "collaboration:expertProfiles",
          project,
        );
        if (current) setProfiles(result);
      } catch (reason) {
        if (current) setError(`发现本机专家配置失败：${String(reason)}`);
      }
    };
    void load();
    return () => {
      current = false;
    };
  }, [project, enabled, revision]);
  return { profiles, error, accepted, setAccepted, reload };
}
