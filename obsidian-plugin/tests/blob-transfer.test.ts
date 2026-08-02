import { describe, expect, it } from "vitest"
import type { EncryptedBlob } from "../src/model"
import { BLOB_TRANSFER_CONCURRENCY, uploadBlobsConcurrently } from "../src/sync/blob-transfer"

function blobs(count: number): EncryptedBlob[] {
  return Array.from({ length: count }, (_, index) => ({
    blobId: `blob-${index}`,
    bytes: new Uint8Array(index + 1).buffer,
    chunkIndex: index,
  }))
}

describe("bounded blob uploads", () => {
  it("uploads at most four chunks and reports monotonic progress", async () => {
    let active = 0
    let maximumActive = 0
    let started = 0
    let releaseInitial: (() => void) | undefined
    const initialGate = new Promise<void>((resolve) => {
      releaseInitial = resolve
    })
    const progress: Array<{ completedChunks: number; transferredBytes: number }> = []

    const uploading = uploadBlobsConcurrently(
      blobs(10),
      async () => {
        active += 1
        started += 1
        maximumActive = Math.max(maximumActive, active)
        if (started <= BLOB_TRANSFER_CONCURRENCY) await initialGate
        active -= 1
      },
      (value) => progress.push(value),
    )
    while (started < BLOB_TRANSFER_CONCURRENCY) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    expect(started).toBe(BLOB_TRANSFER_CONCURRENCY)
    expect(maximumActive).toBe(BLOB_TRANSFER_CONCURRENCY)
    releaseInitial?.()

    await expect(uploading).resolves.toBeUndefined()
    expect(maximumActive).toBe(BLOB_TRANSFER_CONCURRENCY)
    expect(progress.map((value) => value.completedChunks)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(progress.at(-1)?.transferredBytes).toBe(55)
  })

  it("waits for the active batch after failure and starts no later batch", async () => {
    let started = 0
    let completed = 0
    await expect(
      uploadBlobsConcurrently(
        blobs(8),
        async (blob) => {
          started += 1
          await Promise.resolve()
          if (blob.chunkIndex === 1) throw new Error("upload failed")
          completed += 1
        },
        () => {},
      ),
    ).rejects.toThrow("upload failed")

    expect(started).toBe(BLOB_TRANSFER_CONCURRENCY)
    expect(completed).toBe(BLOB_TRANSFER_CONCURRENCY - 1)
  })
})
