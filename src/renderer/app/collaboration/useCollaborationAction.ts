// 人工操作的即时反馈；成功只表示宿主接受操作，不推断模型完成或原生停止。
import { useState } from 'react';
export function useCollaborationAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const act = async (operation: () => Promise<unknown>, success: string) => {
    setBusy(true); setError(''); setFeedback('');
    try { await operation(); setFeedback(success); return true; }
    catch (reason) { setError(String(reason)); return false; }
    finally { setBusy(false); }
  };
  return { busy, error, feedback, act };
}
