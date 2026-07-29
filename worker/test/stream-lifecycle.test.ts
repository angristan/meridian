import { describe, expect, it, vi } from "vitest"
import { observeStreamOutcome } from "../src/http/stream-lifecycle"

describe("observeStreamOutcome", () => {
  it("reports completion after the source reaches EOF", async () => {
    const onOutcome = vi.fn()
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]))
        controller.close()
      },
    })

    const result = await new Response(observeStreamOutcome(source, onOutcome)).arrayBuffer()

    expect(new Uint8Array(result)).toEqual(new Uint8Array([1, 2, 3]))
    expect(onOutcome).toHaveBeenCalledOnce()
    expect(onOutcome).toHaveBeenCalledWith("completed")
  })

  it("reports cancellation and propagates it to the source", async () => {
    const onOutcome = vi.fn()
    const cancel = vi.fn()
    const source = new ReadableStream<Uint8Array>({ cancel })
    const body = observeStreamOutcome(source, onOutcome)

    await body.cancel("client disconnected")

    expect(cancel).toHaveBeenCalledWith("client disconnected")
    expect(onOutcome).toHaveBeenCalledOnce()
    expect(onOutcome).toHaveBeenCalledWith("cancelled")
  })

  it("reports a source stream failure", async () => {
    const onOutcome = vi.fn()
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("R2 stream failed"))
      },
    })
    const reader = observeStreamOutcome(source, onOutcome).getReader()

    await expect(reader.read()).rejects.toThrow("R2 stream failed")
    expect(onOutcome).toHaveBeenCalledOnce()
    expect(onOutcome).toHaveBeenCalledWith("failed")
  })
})
