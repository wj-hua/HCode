// 采纳页面动作及反馈；最终状态来自主进程，预览变化时清除确认。
import { useEffect, useState } from "react";
import type { CollaborationSnapshot } from "@hcode/shared/collaboration";
import type {
  AdoptionPreview,
  AdoptionState,
} from "@hcode/shared/codeAdoption";
import { hcode } from "../bridge";
import { useCollaborationStore } from "./collaborationStore";
export function useCodeAdoption(
  run: CollaborationSnapshot,
  versionId?: string,
) {
  const [preview, setPreview] = useState<AdoptionPreview>();
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<AdoptionState>();
  useEffect(() => {
    setPreview(undefined);
    setConfirmed(false);
    setError("");
    setResult(undefined);
  }, [run.id, versionId]);
  const refresh = async () =>
    useCollaborationStore
      .getState()
      .accept(await hcode.invoke("collaboration:get", run.id));
  /** 每次确认前重新检查；错误不保留旧的可采纳预览。 */
  const inspect = async () => {
    if (!versionId) return;
    setBusy(true);
    setError("");
    setConfirmed(false);
    setPreview(undefined);
    try {
      setPreview(
        await hcode.invoke("collaboration:adoptionPreview", run.id, versionId),
      );
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };
  const apply = async () => {
    if (!preview || !confirmed || !preview.eligible) return;
    setBusy(true);
    setError("");
    setConfirmed(false);
    try {
      setResult(
        await hcode.invoke("collaboration:applyCandidate", run.id, {
          versionId: preview.version.id,
          previewHash: preview.hash,
        }),
      );
      await refresh();
    } catch (reason) {
      setError(String(reason));
      setPreview(undefined);
      await refresh();
    } finally {
      setBusy(false);
    }
  };
  const recover = async () => {
    const state = result ?? run.code?.adoption;
    if (!state) return;
    setBusy(true);
    setError("");
    setConfirmed(false);
    try {
      setResult(
        await hcode.invoke("collaboration:recoverAdoption", run.id, state.id),
      );
      setPreview(undefined);
      await refresh();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };
  return {
    preview,
    confirmed,
    setConfirmed,
    busy,
    error,
    state: result ?? run.code?.adoption,
    inspect,
    apply,
    recover,
  };
}
