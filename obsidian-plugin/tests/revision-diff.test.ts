import { describe, expect, it } from "vitest"
import { buildLineDiff } from "../src/sync/revision-diff"

describe("revision text diff", () => {
  it("preserves shared context around a changed block", () => {
    expect(buildLineDiff("one\ntwo\nthree", "one\nchanged\nthree")).toEqual({
      lines: [
        { kind: "context", text: "one" },
        { kind: "removed", text: "two" },
        { kind: "added", text: "changed" },
        { kind: "context", text: "three" },
      ],
      truncated: false,
    })
  })

  it("bounds output while retaining both ends", () => {
    const result = buildLineDiff("a\nb\nc\nd", "w\nx\ny\nz", 4)

    expect(result).toEqual({
      lines: [
        { kind: "removed", text: "a" },
        { kind: "removed", text: "b" },
        { kind: "added", text: "y" },
        { kind: "added", text: "z" },
      ],
      truncated: true,
    })
  })

  it("rejects invalid line limits", () => {
    expect(() => buildLineDiff("", "", 0)).toThrow(/limit/)
  })
})
