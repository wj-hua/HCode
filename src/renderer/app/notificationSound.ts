// 通知提示音：内置语音随前端资源打包，自定义文件经主进程读取后播放。
import type { NotificationEvent, NotificationSound, Settings } from "@hcode/shared/types";
import { hcode } from "./bridge";
import xiaoyiDone from "./sounds/xiaoyi-done.mp3";
import xiaoyiError from "./sounds/xiaoyi-error.mp3";
import xiaoyiApproval from "./sounds/xiaoyi-approval.mp3";
import xiaoxiaoDone from "./sounds/xiaoxiao-done.mp3";
import xiaoxiaoError from "./sounds/xiaoxiao-error.mp3";
import xiaoxiaoApproval from "./sounds/xiaoxiao-approval.mp3";
import xiaoDone from "./sounds/xiao-done.mp3";
import xiaoError from "./sounds/xiao-error.mp3";
import xiaoApproval from "./sounds/xiao-approval.mp3";

type BuiltinSound = Exclude<NotificationSound, "system" | "custom" | "none">;

const BUILTIN_SOUNDS: Record<BuiltinSound, Record<NotificationEvent, string>> = {
  xiaoyi: { done: xiaoyiDone, error: xiaoyiError, approval: xiaoyiApproval },
  xiaoxiao: { done: xiaoxiaoDone, error: xiaoxiaoError, approval: xiaoxiaoApproval },
  xiao: { done: xiaoDone, error: xiaoError, approval: xiaoApproval },
};

export const isBuiltinSound = (sound: NotificationSound): sound is BuiltinSound => sound in BUILTIN_SOUNDS;

export const NOTIFICATION_SOUND_OPTIONS: { value: NotificationSound; label: string }[] = [
  { value: "system", label: "系统" },
  { value: "xiaoyi", label: "晓伊" },
  { value: "xiaoxiao", label: "晓晓" },
  { value: "xiao", label: "潇" },
  { value: "custom", label: "自定义" },
  { value: "none", label: "静音" },
];

export const NOTIFICATION_EVENTS: { value: NotificationEvent; label: string }[] = [
  { value: "done", label: "任务完成" },
  { value: "error", label: "运行出错" },
  { value: "approval", label: "等待审批" },
];

async function play(src: string, revoke = false) {
  const audio = new Audio(src);
  if (revoke) audio.onended = audio.onerror = () => URL.revokeObjectURL(src);
  await audio.play();
}

async function playFile(path: string): Promise<boolean> {
  const bytes = path ? await hcode.invoke("fs:readAudio", path) : null;
  if (!bytes) return false;
  await play(URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>])), true);
  return true;
}

/**
 * 按设置播放 HCode 自己的提示音。返回 true 表示已接管声音（系统通知应静音）；
 * 选了「系统」或自定义文件不可用时返回 false，交给系统提示音。
 */
export async function playNotificationSound(settings: Settings, event: NotificationEvent): Promise<boolean> {
  const sound = settings.notificationSound;
  if (sound === "none") return true;
  if (sound === "system") return false;
  if (sound === "custom") return playFile(settings.customSounds[event]).catch(() => false);
  await play(BUILTIN_SOUNDS[sound][event]).catch(() => undefined);
  return true;
}
