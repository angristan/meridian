import { signedHttpMessage } from "@meridian/protocol"
import { describe, expect, it } from "vitest"
import {
  base64UrlDecode,
  base64UrlEncode,
  constantTimeSecretEquals,
  ZERO_HASH,
} from "../src/encoding"

describe("encoding", () => {
  it("round trips unpadded base64url", () => {
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255])
    const encoded = base64UrlEncode(bytes)
    expect(encoded).toBe("AAEC_f7_")
    expect(base64UrlDecode(encoded)).toEqual(bytes)
    expect(base64UrlDecode(ZERO_HASH)).toHaveLength(32)
  })

  it("uses unambiguous field length prefixes", () => {
    const first = signedHttpMessage("test/v1", [["a", "bc"]])
    const second = signedHttpMessage("test/v1", [["ab", "c"]])
    expect(base64UrlEncode(first)).not.toBe(base64UrlEncode(second))
    expect(base64UrlEncode(first)).toBe(
      base64UrlEncode(signedHttpMessage("test/v1", [["a", "bc"]])),
    )
  })

  it("compares secret digests without comparing raw lengths", async () => {
    await expect(constantTimeSecretEquals("same", "same")).resolves.toBe(true)
    await expect(constantTimeSecretEquals("same", "different")).resolves.toBe(false)
  })
})
