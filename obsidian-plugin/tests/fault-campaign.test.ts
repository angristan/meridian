import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  clearFailureTrace,
  createTrace,
  DeterministicRandom,
  persistFailureTrace,
  traceEvent,
} from "./fault-campaign"

const originalTraceDirectory = process.env.MERIDIAN_FAULT_TRACE_DIR

afterEach(() => {
  if (originalTraceDirectory === undefined) delete process.env.MERIDIAN_FAULT_TRACE_DIR
  else process.env.MERIDIAN_FAULT_TRACE_DIR = originalTraceDirectory
})

describe("seeded fault campaign support", () => {
  it("generates a stable unsigned 32-bit sequence", () => {
    const random = new DeterministicRandom(12_345)
    expect(Array.from({ length: 5 }, () => random.nextUint32())).toEqual([
      3_336_926_330, 1_697_253_807, 2_816_511_904, 1_955_480_042, 718_842_323,
    ])

    const shuffled = new DeterministicRandom(12_345).shuffle([
      "none",
      "response",
      "snapshot",
      "revision",
      "completion",
      "checkpoint",
    ])
    expect(new Set(shuffled)).toEqual(
      new Set(["none", "response", "snapshot", "revision", "completion", "checkpoint"]),
    )
  })

  it("writes and clears a stable ordered failure trace", async () => {
    const directory = await mkdtemp(join(tmpdir(), "meridian-fault-trace-"))
    process.env.MERIDIAN_FAULT_TRACE_DIR = directory
    const trace = createTrace(123, 8)
    traceEvent(trace, "planned", { step: 0, fault: "checkpoint" })
    traceEvent(trace, "fault-settled", { step: 0, checkpoint: 1 })

    const path = await persistFailureTrace(trace, new Error("Injected campaign failure"))
    expect(path).toBe(join(directory, "plugin-seed-123-steps-8.json"))
    await expect(readFile(path, "utf8")).resolves.toBe(
      `${JSON.stringify(
        {
          version: 1,
          seed: 123,
          configuredSteps: 8,
          events: [
            { index: 0, kind: "planned", values: { step: 0, fault: "checkpoint" } },
            { index: 1, kind: "fault-settled", values: { step: 0, checkpoint: 1 } },
          ],
          failure: { message: "Injected campaign failure" },
        },
        null,
        2,
      )}\n`,
    )

    await clearFailureTrace(123, 8)
    await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
    await rm(directory, { recursive: true, force: true })
  })
})
