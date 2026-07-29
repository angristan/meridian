import { describe, expect, it } from "vitest"
import { presentSyncProgress } from "../src/ui/sync-progress"

describe("sync progress presentation", () => {
  it("shows durable cursor and current download chunk progress", () => {
    expect(
      presentSyncProgress({
        kind: "pull",
        startCursor: 100,
        currentCursor: 125,
        targetCursor: 150,
        currentChunk: 2,
        totalChunks: 4,
        transferredBytes: 5 * 1024 * 1024,
        totalBytes: 10 * 1024 * 1024,
      }),
    ).toEqual({
      label: "Downloading changes · 25 / 50",
      detail: "Cursor 100 → 125 of 150 · change 26 of 50 · chunk 2 of 4 · 5.0 MiB of 10 MiB",
      value: 25,
      max: 50,
    })
  })

  it("shows file path stage failures and upload bytes", () => {
    expect(
      presentSyncProgress({
        kind: "push",
        processed: 3,
        succeeded: 2,
        failed: 1,
        total: 10,
        currentPath: "Notion/Attachments/photo.png",
        stage: "uploading",
        currentChunk: 1,
        totalChunks: 2,
        transferredBytes: 1024,
        totalBytes: 2048,
        currentCursor: 125,
      }),
    ).toEqual({
      label: "Uploading files · 3 / 10",
      detail:
        "Uploading Notion/Attachments/photo.png · chunk 1 of 2 · 1.0 KiB of 2.0 KiB · 1 failed",
      value: 3,
      max: 10,
    })
  })
})
