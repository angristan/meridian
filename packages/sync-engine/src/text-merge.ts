export interface MergeSuccess {
  readonly status: "merged"
  readonly content: Uint8Array
}

export interface MergeConflict {
  readonly status: "conflict"
  readonly reason: "invalid-utf8" | "overlapping-edits" | "merge-too-large"
}

export type TextMergeResult = MergeSuccess | MergeConflict

interface Hunk {
  readonly start: number
  readonly end: number
  readonly replacement: readonly string[]
}

const utf8Decoder = new TextDecoder("utf-8", { fatal: true })
const utf8Encoder = new TextEncoder()
const MAX_LCS_CELLS = 4_000_000

function decode(content: Uint8Array): string | undefined {
  try {
    return utf8Decoder.decode(content)
  } catch {
    return undefined
  }
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function diff(base: readonly string[], changed: readonly string[]): readonly Hunk[] | undefined {
  const width = changed.length + 1
  const cells = (base.length + 1) * width
  if (cells > MAX_LCS_CELLS) return undefined

  const lcs = new Uint32Array(cells)
  const at = (baseIndex: number, changedIndex: number) => baseIndex * width + changedIndex
  for (let baseIndex = base.length - 1; baseIndex >= 0; baseIndex -= 1) {
    for (let changedIndex = changed.length - 1; changedIndex >= 0; changedIndex -= 1) {
      lcs[at(baseIndex, changedIndex)] =
        base[baseIndex] === changed[changedIndex]
          ? (lcs[at(baseIndex + 1, changedIndex + 1)] ?? 0) + 1
          : Math.max(
              lcs[at(baseIndex + 1, changedIndex)] ?? 0,
              lcs[at(baseIndex, changedIndex + 1)] ?? 0,
            )
    }
  }

  const hunks: Hunk[] = []
  let baseIndex = 0
  let changedIndex = 0
  let start: number | undefined
  let replacement: string[] = []
  const flush = () => {
    if (start === undefined) return
    hunks.push({ start, end: baseIndex, replacement })
    start = undefined
    replacement = []
  }

  while (baseIndex < base.length || changedIndex < changed.length) {
    if (
      baseIndex < base.length &&
      changedIndex < changed.length &&
      base[baseIndex] === changed[changedIndex]
    ) {
      flush()
      baseIndex += 1
      changedIndex += 1
    } else if (
      changedIndex < changed.length &&
      (baseIndex >= base.length ||
        (lcs[at(baseIndex, changedIndex + 1)] ?? 0) > (lcs[at(baseIndex + 1, changedIndex)] ?? 0))
    ) {
      const inserted = changed[changedIndex]
      if (inserted === undefined) throw new Error("Diff index invariant failed")
      start ??= baseIndex
      replacement.push(inserted)
      changedIndex += 1
    } else {
      start ??= baseIndex
      baseIndex += 1
    }
  }
  flush()
  return hunks
}

function sameHunk(left: Hunk, right: Hunk): boolean {
  return (
    left.start === right.start &&
    left.end === right.end &&
    arraysEqual(left.replacement, right.replacement)
  )
}

function strictlyBefore(left: Hunk, right: Hunk): boolean {
  if (left.end < right.start) return true
  if (left.end > right.start) return false
  return !(left.start === left.end && right.start === right.end)
}

function combineHunks(left: readonly Hunk[], right: readonly Hunk[]): readonly Hunk[] | undefined {
  const combined: Hunk[] = []
  let leftIndex = 0
  let rightIndex = 0
  while (leftIndex < left.length || rightIndex < right.length) {
    const leftHunk = left[leftIndex]
    const rightHunk = right[rightIndex]
    if (leftHunk === undefined && rightHunk !== undefined) {
      combined.push(rightHunk)
      rightIndex += 1
    } else if (rightHunk === undefined && leftHunk !== undefined) {
      combined.push(leftHunk)
      leftIndex += 1
    } else if (leftHunk !== undefined && rightHunk !== undefined) {
      if (sameHunk(leftHunk, rightHunk)) {
        combined.push(leftHunk)
        leftIndex += 1
        rightIndex += 1
      } else if (strictlyBefore(leftHunk, rightHunk)) {
        combined.push(leftHunk)
        leftIndex += 1
      } else if (strictlyBefore(rightHunk, leftHunk)) {
        combined.push(rightHunk)
        rightIndex += 1
      } else {
        return undefined
      }
    }
  }
  return combined
}

/**
 * Deterministically merges line-oriented UTF-8. It is deliberately conservative:
 * ambiguous overlapping changes are surfaced instead of choosing a winner.
 */
export function mergeUtf8Text(
  baseContent: Uint8Array,
  leftContent: Uint8Array,
  rightContent: Uint8Array,
): TextMergeResult {
  const baseText = decode(baseContent)
  const leftText = decode(leftContent)
  const rightText = decode(rightContent)
  if (baseText === undefined || leftText === undefined || rightText === undefined) {
    return { status: "conflict", reason: "invalid-utf8" }
  }
  if (leftText === rightText) return { status: "merged", content: new Uint8Array(leftContent) }
  if (leftText === baseText) return { status: "merged", content: new Uint8Array(rightContent) }
  if (rightText === baseText) return { status: "merged", content: new Uint8Array(leftContent) }

  const base = baseText.split("\n")
  const left = leftText.split("\n")
  const right = rightText.split("\n")
  const leftHunks = diff(base, left)
  const rightHunks = diff(base, right)
  if (leftHunks === undefined || rightHunks === undefined) {
    return { status: "conflict", reason: "merge-too-large" }
  }
  const hunks = combineHunks(leftHunks, rightHunks)
  if (hunks === undefined) return { status: "conflict", reason: "overlapping-edits" }

  const output: string[] = []
  let position = 0
  for (const hunk of hunks) {
    output.push(...base.slice(position, hunk.start), ...hunk.replacement)
    position = hunk.end
  }
  output.push(...base.slice(position))
  return { status: "merged", content: utf8Encoder.encode(output.join("\n")) }
}
