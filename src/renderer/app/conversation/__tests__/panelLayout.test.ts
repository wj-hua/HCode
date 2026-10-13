import { describe, it, expect } from 'vitest';
import { constrainPanelWidth, panelWidthBounds } from '../panelLayout';
describe('协作面板布局边界', () => {
  it('宽窗口调整同时保留至少 360 像素消息区', () => {
    expect(panelWidthBounds(1200)).toEqual({ min: 320, max: 840 });
    expect(constrainPanelWidth(1000, 1200)).toBe(840);
    expect(constrainPanelWidth(100, 1200)).toBe(320);
  });
  it('窄窗口覆盖面板保留关闭后的会话空间，不越出可见窗口', () => {
    expect(constrainPanelWidth(480, 400)).toBe(340);
    expect(constrainPanelWidth(320, 200)).toBe(170);
    expect(constrainPanelWidth(480, 0)).toBe(0);
  });
});
