import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
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

  it("rejects the wrong content type", async () => {
    const request = new Request("https://example.test", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ payload: "value" }),
    })

    await expect(Effect.runPromise(decodeJsonEffect(request, PayloadSchema))).rejects.toMatchObject(
      {
        status: 415,
        code: "unsupported_media_type",
      },
    )
  })

  it("rejects malformed JSON", async () => {
    const request = new Request("https://example.test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    })

    await expect(Effect.runPromise(decodeJsonEffect(request, PayloadSchema))).rejects.toMatchObject(
      {
        status: 400,
        code: "invalid_json",
      },
    )
  })

  it("rejects schema mismatches and excess properties", async () => {
    const request = new Request("https://example.test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payload: 1, extra: true }),
    })

    await expect(Effect.runPromise(decodeJsonEffect(request, PayloadSchema))).rejects.toMatchObject(
      {
        status: 400,
        code: "invalid_request",
      },
    )
  })

  it("still rejects bodies beyond the public limit", async () => {
    await expect(
      Effect.runPromise(decodeJsonEffect(jsonRequest(2 * 1024 * 1024), PayloadSchema)),
    ).rejects.toMatchObject({ status: 413, code: "body_too_large" })
  })

  it("cancels chunked bodies as soon as they exceed the limit", async () => {
    let pulls = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1
        if (pulls === 1) {
          controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1))
        } else {
          controller.enqueue(new Uint8Array(1024 * 1024))
        }
      },
    })
    const request = {
      headers: new Headers({ "content-type": "application/json" }),
      body,
    } as Request

    await expect(Effect.runPromise(decodeJsonEffect(request, PayloadSchema))).rejects.toMatchObject(
      { status: 413, code: "body_too_large" },
    )
    expect(pulls).toBe(1)
  })
})
