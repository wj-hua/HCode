import { describe, expect, it } from "vitest";
import { parseBattery } from "../battery.js";

describe("电脑电量", () => {
  it("读取内置电池的电量和充电状态", () => {
    expect(parseBattery("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t72%; charging; 1:00 remaining present: true"))
      .toEqual({ percentage: 72, status: "charging" });
    expect(parseBattery(" -InternalBattery-0 (id=1)\t19%; discharging; 0:30 remaining present: true"))
      .toEqual({ percentage: 19, status: "discharging" });
    expect(parseBattery(" -InternalBattery-0 (id=1)\t100%; charged; 0:00 remaining present: true"))
      .toEqual({ percentage: 100, status: "charged" });
    expect(parseBattery(" -InternalBattery-0 (id=1)\t80%; not charging; present: true"))
      .toEqual({ percentage: 80, status: "not-charging" });
  });
  it("不把外接设备或无效数据当作电脑电池", () => {
    expect(parseBattery("Now drawing from 'AC Power'\n -UPS-0 50%; discharging;")).toBeNull();
    expect(parseBattery(" -InternalBattery-0 101%; charging;")).toBeNull();
  });
});
