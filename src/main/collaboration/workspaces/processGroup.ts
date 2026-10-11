// 验证进程组的可信停止边界；只查询 PID/PGID/状态，绝不读取进程命令或环境。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CODE_WORKSPACE_LIMITS } from '../../../shared/codeDelivery.js';
const exec = promisify(execFile);
const STOP_POLL_MS = 25;
/** 沙箱已禁止创建新会话/进程组；僵尸已退出不能写文件，其他成员必须全部消失。 */
export async function confirmProcessGroupStopped(group: number) {
  const deadline = Date.now() + CODE_WORKSPACE_LIMITS.stopTimeoutMs;
  while (Date.now() < deadline) {
    const {stdout} = await exec('/bin/ps', ['-axo', 'pid=,pgid=,stat='], {timeout:1000,maxBuffer:1024*1024}).catch((error: unknown) => {
      throw new Error('验证进程停止未确认：系统进程查询失败；工作区租约保持锁定', { cause: error });
    });
    const running = stdout.trim().split('\n').some((line) => { const fields = line.trim().split(/\s+/); return Number(fields[1]) === group && !fields[2]?.startsWith('Z'); });
    if (!running) return;
    await new Promise((resolve) => setTimeout(resolve, STOP_POLL_MS));
  }
  throw new Error('验证进程停止未确认；工作区租约保持锁定');
}
