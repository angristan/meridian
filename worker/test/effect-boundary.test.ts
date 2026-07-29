import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { decodeJsonEffect } from "../src/http/effect-boundary"

const PayloadSchema = Schema.Struct({ payload: Schema.String })

function jsonRequest(payloadBytes: number): Request {
  return new Request("https://example.test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ payload: "a".repeat(payloadBytes) }),
  })
}

describe("JSON request boundary", () => {
  it("accepts recovery-sized base64 payloads", async () => {
    const decoded = await Effect.runPromise(decodeJsonEffect(jsonRequest(1_500_000), PayloadSchema))

    expect(decoded.payload).toHaveLength(1_500_000)
  })

  it("still rejects bodies beyond the public limit", async () => {
    await expect(
      Effect.runPromise(decodeJsonEffect(jsonRequest(2 * 1024 * 1024), PayloadSchema)),
    ).rejects.toMatchObject({ status: 413, code: "body_too_large" })
  })
})
