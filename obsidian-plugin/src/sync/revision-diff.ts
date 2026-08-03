import type { RevisionDiffLine } from "../model"

interface LineDiffResult {
  lines: RevisionDiffLine[]
  truncated: boolean
}

export function buildLineDiff(before: string, after: string, maximumLines = 2_000): LineDiffResult {
  if (!Number.isSafeInteger(maximumLines) || maximumLines < 1) {
    throw new RangeError("Diff line limit is invalid")
  }
  const beforeLines = before.split("\n")
  const afterLines = after.split("\n")
  let prefix = 0
  while (
    prefix < beforeLines.length &&
    prefix < afterLines.length &&
    beforeLines[prefix] === afterLines[prefix]
  ) {
    prefix += 1
  }

  let suffix = 0
  while (
    suffix < beforeLines.length - prefix &&
    suffix < afterLines.length - prefix &&
    beforeLines[beforeLines.length - suffix - 1] === afterLines[afterLines.length - suffix - 1]
  ) {
    suffix += 1
  }

  const lines: RevisionDiffLine[] = []
  append(lines, beforeLines.slice(0, prefix), "context")
  append(lines, beforeLines.slice(prefix, beforeLines.length - suffix), "removed")
  append(lines, afterLines.slice(prefix, afterLines.length - suffix), "added")
  if (suffix > 0) append(lines, beforeLines.slice(beforeLines.length - suffix), "context")

  if (lines.length <= maximumLines) return { lines, truncated: false }
  const headCount = Math.ceil(maximumLines / 2)
  const tailCount = Math.floor(maximumLines / 2)
  return {
    lines: [...lines.slice(0, headCount), ...lines.slice(lines.length - tailCount)],
    truncated: true,
  }
}

function append(
  target: RevisionDiffLine[],
  values: readonly string[],
  kind: RevisionDiffLine["kind"],
): void {
  for (const text of values) target.push({ kind, text })
}
