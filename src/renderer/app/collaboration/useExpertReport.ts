// 冻结报告读取边界；切换协作或引用后，旧 IPC 响应不能覆盖当前证据。
import { useCallback, useEffect, useRef, useState } from 'react';
import type { InvokeMap } from '@hcode/shared/ipc';
import type { ExpertClaimRef } from '@hcode/shared/experts';
import { hcode } from '../bridge';

export function useExpertReport(runId: string, citation?: ExpertClaimRef & { label: string }) {
  const [report, setReport] = useState<InvokeMap['collaboration:artifact'][1]>();
  const [claimId, setClaimId] = useState<string>();
  const [reportLabel, setReportLabel] = useState('');
  const [reading, setReading] = useState(false);
  const [error, setError] = useState('');
  const sequence = useRef(0);
  useEffect(() => {
    setReport(undefined); setClaimId(undefined); setReportLabel(''); setReading(false); setError('');
    return () => { sequence.current++; };
  }, [runId]);

  /** 只读宿主已校验的冻结版本；错误可见，过期响应被撤销而不是冒充新结果。 */
  const openReport = useCallback(async (versionId: string, name: string, claim?: string) => {
    const request = ++sequence.current;
    setClaimId(claim); setReading(true); setError(''); setReport(undefined); setReportLabel(name);
    try {
      const artifact = await hcode.invoke('collaboration:artifact', runId, versionId);
      if (request === sequence.current) setReport(artifact);
    } catch (reason) {
      if (request === sequence.current) setError(String(reason));
    } finally {
      if (request === sequence.current) setReading(false);
    }
  }, [runId]);
  useEffect(() => {
    if (citation) void openReport(citation.versionId, citation.label, citation.claimId);
    return () => { sequence.current++; };
  }, [citation, openReport]);
  return { report, claimId, reportLabel, reading, error, openReport };
}
