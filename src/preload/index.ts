import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from "electron";
import {
  EVENT_CHANNELS,
  INVOKE_CHANNELS,
  type EventChannel,
  type HCodeBridge,
  type InvokeChannel,
} from "../shared/ipc.js";

const invokeChannels = new Set<string>(INVOKE_CHANNELS);
const eventChannels = new Set<string>(EVENT_CHANNELS);

const bridge: HCodeBridge = {
  invoke(channel: InvokeChannel, ...args: unknown[]) {
    if (!invokeChannels.has(channel)) {
      return Promise.reject(new Error(`Unknown IPC channel: ${channel}`));
    }
    return ipcRenderer.invoke(channel, ...args);
  },
  on(channel: EventChannel, listener: (payload: unknown) => void) {
    if (!eventChannels.has(channel)) {
      throw new Error(`Unknown IPC event: ${channel}`);
    }
    const wrapped = (_event: IpcRendererEvent, payload: unknown) => listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => {
      ipcRenderer.removeListener(channel, wrapped);
    };
  },
  platform: process.platform,
  getPathForFile(file: File) {
    try {
      return webUtils.getPathForFile(file) || null;
    } catch {
      return null;
    }
  },
} as HCodeBridge;

contextBridge.exposeInMainWorld("hcode", bridge);
