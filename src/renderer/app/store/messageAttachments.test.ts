import { afterEach, expect, it, vi } from "vitest";
import { restoreMessageAttachments } from "./messageAttachments";
import type { ConversationRow } from "@hcode/shared/types";

afterEach(() => vi.unstubAllGlobals());

it("编辑和重发远程图片时按需取回原图，保留文件名与本地附件", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "image/png", "Content-Length": "3" } }));
  vi.stubGlobal("fetch", fetch);
  const row = { kind: "userInput", attachments: [
    { ref: "api/media/signed-image", fileName: "shot.png", mime: "image/png", bytes: 3 },
    { ref: "/tmp/report.txt", fileName: "report.txt", mime: "text/plain", bytes: 2 },
  ] } as Extract<ConversationRow, { kind: "userInput" }>;
  expect(await restoreMessageAttachments(row)).toEqual({ images: [{ mimeType: "image/png", data: "AQID", name: "shot.png" }], files: [{ path: "/tmp/report.txt", name: "report.txt", mimeType: "text/plain", size: 2 }] });
  expect(fetch).toHaveBeenCalledWith("api/media/signed-image", expect.objectContaining({ credentials: "same-origin" }));
  fetch.mockResolvedValue(new Response("expired", { status: 401 }));
  await expect(restoreMessageAttachments(row)).rejects.toThrow("401");
});
