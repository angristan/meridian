import type { EncryptedBlob } from "../model"

export const BLOB_TRANSFER_CONCURRENCY = 4

export interface BlobUploadProgress {
  completedChunks: number
  transferredBytes: number
}

export async function uploadBlobsConcurrently(
  blobs: readonly EncryptedBlob[],
  upload: (blob: EncryptedBlob) => Promise<void>,
  onProgress: (progress: BlobUploadProgress) => void,
): Promise<void> {
  let completedChunks = 0
  let transferredBytes = 0

  for (let start = 0; start < blobs.length; start += BLOB_TRANSFER_CONCURRENCY) {
    const batch = blobs.slice(start, start + BLOB_TRANSFER_CONCURRENCY)
    const results = await Promise.allSettled(
      batch.map(async (blob) => {
        await upload(blob)
        completedChunks += 1
        transferredBytes += blob.bytes.byteLength
        onProgress({ completedChunks, transferredBytes })
      }),
    )
    const failed = results.find((result) => result.status === "rejected")
    if (failed?.status === "rejected") throw failed.reason
  }
}
