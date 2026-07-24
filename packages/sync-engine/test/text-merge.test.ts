import { describe, expect, it } from "vitest"
import { mergeUtf8Text } from "../src/index"

const encode = (value: string) => new TextEncoder().encode(value)
const decode = (value: Uint8Array) => new TextDecoder().decode(value)

describe("mergeUtf8Text", () => {
  it("combines non-overlapping line edits", () => {
    const result = mergeUtf8Text(
      encode("title\nalpha\nbeta\nend"),
      encode("title changed\nalpha\nbeta\nend"),
      encode("title\nalpha\nbeta changed\nend"),
    )

    expect(result.status).toBe("merged")
    if (result.status === "merged") {
      expect(decode(result.content)).toBe("title changed\nalpha\nbeta changed\nend")
    }
  })

  it("accepts identical concurrent edits", () => {
    const result = mergeUtf8Text(encode("old"), encode("new"), encode("new"))
    expect(result.status).toBe("merged")
    if (result.status === "merged") expect(decode(result.content)).toBe("new")
  })

  it("surfaces overlapping edits and invalid UTF-8", () => {
    expect(mergeUtf8Text(encode("old"), encode("left"), encode("right"))).toEqual({
      status: "conflict",
      reason: "overlapping-edits",
    })
    expect(mergeUtf8Text(encode("old"), new Uint8Array([0xff]), encode("right"))).toEqual({
      status: "conflict",
      reason: "invalid-utf8",
    })
  })
})
