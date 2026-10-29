// 远程附件的小尺寸预览；只改变展示图片，原始附件仍通过独立地址读取。
import { nativeImage } from "electron";
import type { RemoteImage } from "./remoteMedia.js";

const THUMBNAIL_EDGE = 192;

export function remoteImageThumbnail(image: RemoteImage): RemoteImage {
  const native = nativeImage.createFromBuffer(image.body);
  // Electron 不支持的图片格式保持原样，避免已有附件因缩略图编解码能力而不可见。
  if (native.isEmpty()) return image;
  const size = native.getSize();
  const scale = Math.min(1, THUMBNAIL_EDGE / Math.max(size.width, size.height));
  const thumbnail = native.resize({ width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)), quality: "good" });
  return { body: thumbnail.toPNG(), type: "image/png" };
}
