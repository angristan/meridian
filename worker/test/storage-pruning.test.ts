import { describe, expect, it } from "vitest"
import { isSafeOrphanCandidate } from "../src/vault/operations"

describe("safe orphan pruning", () => {
  const cutoff = 1_000

  it("deletes only old unreferenced and unclaimed uploads", () => {
    expect(isSafeOrphanCandidate(999, undefined, cutoff, false)).toBe(true)
    expect(isSafeOrphanCandidate(999, 998, cutoff, false)).toBe(true)
  })

  it("preserves retained, recent, and recently claimed uploads", () => {
    expect(isSafeOrphanCandidate(1, undefined, cutoff, true)).toBe(false)
    expect(isSafeOrphanCandidate(cutoff, undefined, cutoff, false)).toBe(false)
    expect(isSafeOrphanCandidate(1, cutoff, cutoff, false)).toBe(false)
  })
})
