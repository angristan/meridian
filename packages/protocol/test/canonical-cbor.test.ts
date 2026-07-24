import { describe, expect, it } from "vitest"
import {
  bytesToHex,
  CanonicalCborError,
  decodeCanonical,
  encodeCanonical,
  hexToBytes,
} from "../src/index.js"
import vectors from "./vectors/canonical-cbor.json"

describe("canonical CBOR", () => {
  it.each(vectors.valid)("accepts and reproduces $name", ({ hex }) => {
    const bytes = hexToBytes(hex)
    expect(bytesToHex(encodeCanonical(decodeCanonical(bytes)))).toBe(hex.toLowerCase())
  })

  it.each(vectors.invalid)("rejects $name", ({ hex }) => {
    expect(() => decodeCanonical(hexToBytes(hex))).toThrow(CanonicalCborError)
  })

  it("orders map keys by encoded length then lexical bytes", () => {
    expect(bytesToHex(encodeCanonical({ b: 1, a: 2, aa: 3 }))).toBe("a361610261620162616103")
  })

  it("rejects unsupported values and cyclic input", () => {
    expect(() => encodeCanonical(1.5)).toThrow(/safe integers/)
    const cyclic: { self?: unknown } = {}
    cyclic.self = cyclic
    expect(() => encodeCanonical(cyclic as never)).toThrow(/cycles/)
  })
})
