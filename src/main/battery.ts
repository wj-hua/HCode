import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ComputerBattery } from "../shared/types.js";

const execFileAsync = promisify(execFile);

/** pmset 没有内置电池时只返回电源来源，不把外接设备电量当成电脑电量。 */
export function parseBattery(output: string): ComputerBattery | null {
  const line = output.split(/\r?\n/).find((item) => /InternalBattery/i.test(item));
  const match = line?.match(/\b(\d{1,3})%;\s*([^;\n]+)/);
  if (!match) return null;
  const percentage = Number(match[1]);
  if (percentage > 100) return null;
  const status = match[2]!.trim().toLowerCase();
  return {
    percentage,
    status: status === "charging" ? "charging" : status === "discharging" ? "discharging"
      : status === "charged" ? "charged" : status === "not charging" ? "not-charging" : "unknown",
  };
}

export async function getComputerBattery(): Promise<ComputerBattery | null> {
  if (process.platform !== "darwin") return null;
  try {
    const { stdout } = await execFileAsync("/usr/bin/pmset", ["-g", "batt"], { timeout: 5000, maxBuffer: 64 * 1024 });
    return parseBattery(stdout);
  } catch {
    return null;
  }
}
