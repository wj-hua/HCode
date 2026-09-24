export function formatRelativeTime(timestamp: number, now = Date.now()): string {
  const diff = Math.max(0, now - timestamp);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return "刚刚";
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 30 * day) return `${Math.floor(diff / day)} 天前`;
  const date = new Date(timestamp);
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}

/** 侧边栏会话行的紧凑时间，照 ZCode formatTaskRelativeTime（“5分”“3小时”“2天”）。 */
export function formatCompactRelativeTime(timestamp: number, now = Date.now()): string {
  const minutes = Math.floor(Math.max(0, now - timestamp) / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes}分`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时`;
  return `${Math.floor(hours / 24)}天`;
}

export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分钟`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

export function shortenHome(path: string): string {
  const match = /^\/Users\/[^/]+/.exec(path);
  return match ? `~${path.slice(match[0].length)}` : path;
}

/** 额度重置倒计时，如 “3 小时 36 分后重置”。 */
export function formatResetIn(resetsAt: number, now = Date.now()): string {
  const minutes = Math.ceil((resetsAt - now) / 60_000);
  if (minutes <= 0) return "即将重置";
  if (minutes < 60) return `${minutes} 分钟后重置`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours} 小时 ${minutes % 60} 分后重置` : `${hours} 小时后重置`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days} 天 ${hours % 24} 小时后重置` : `${days} 天后重置`;
}
