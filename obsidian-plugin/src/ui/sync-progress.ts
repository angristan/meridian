import type { SyncProgress } from "../model"

export interface SyncProgressPresentation {
  label: string
  detail: string
  value: number
  max: number
}

export function presentSyncProgress(progress: SyncProgress): SyncProgressPresentation {
  if (progress.kind === "pull") {
    const max = Math.max(0, progress.targetCursor - progress.startCursor)
    const value = clamp(progress.currentCursor - progress.startCursor, 0, max)
    const detail = [
      `Cursor ${progress.startCursor} → ${progress.currentCursor} of ${progress.targetCursor}`,
    ]
    if (progress.currentChunk !== null && progress.totalChunks !== null) {
      const change = Math.min(value + 1, max)
      detail.push(`change ${change} of ${max}`)
      detail.push(`chunk ${progress.currentChunk} of ${progress.totalChunks}`)
      if (progress.totalBytes !== null) {
        detail.push(
          `${formatBytes(progress.transferredBytes)} of ${formatBytes(progress.totalBytes)}`,
        )
      }
    }
    return {
      label: `Downloading changes · ${value} / ${max}`,
      detail: detail.join(" · "),
      value,
      max,
    }
  }

  const detail: string[] = []
  if (progress.currentPath && progress.stage) {
    detail.push(`${stageLabel(progress.stage)} ${progress.currentPath}`)
  }
  if (progress.currentChunk !== null && progress.totalChunks !== null) {
    detail.push(`chunk ${progress.currentChunk} of ${progress.totalChunks}`)
    if (progress.totalBytes !== null) {
      detail.push(
        `${formatBytes(progress.transferredBytes)} of ${formatBytes(progress.totalBytes)}`,
      )
    }
  }
  if (progress.failed > 0) detail.push(`${progress.failed} failed`)
  if (detail.length === 0) detail.push(`${progress.succeeded} uploaded`)
  return {
    label: `Uploading files · ${progress.processed} / ${progress.total}`,
    detail: detail.join(" · "),
    value: progress.processed,
    max: progress.total,
  }
}

function stageLabel(stage: NonNullable<Extract<SyncProgress, { kind: "push" }>["stage"]>): string {
  if (stage === "encrypting") return "Encrypting"
  if (stage === "committing") return "Committing"
  return "Uploading"
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ["KiB", "MiB", "GiB"]
  let value = bytes / 1024
  let unit = units[0]
  for (const candidate of units.slice(1)) {
    if (value < 1024) break
    value /= 1024
    unit = candidate
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${unit}`
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum)
}
