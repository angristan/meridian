import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { SyncSimulator } from "../src/index"

const actionArbitrary = fc.record({
  device: fc.integer({ min: 0, max: 2 }),
  kind: fc.constantFrom("append", "replace", "rename", "delete", "binary"),
  value: fc.integer({ min: 0, max: 1_000_000 }),
})

function hexToBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length / 2)
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected test value")
  return value
}

function shuffledCursors(length: number, seed: number): number[] {
  const cursors = Array.from({ length }, (_, index) => index + 1)
  let state = seed | 0
  for (let index = cursors.length - 1; index > 0; index -= 1) {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    const swap = Math.abs(state) % (index + 1)
    const value = required(cursors[index])
    cursors[index] = required(cursors[swap])
    cursors[swap] = value
  }
  return cursors
}

describe("deterministic sync simulator", () => {
  it("converges without silent loss across arbitrary offline histories", () => {
    fc.assert(
      fc.property(
        fc.array(actionArbitrary, { minLength: 1, maxLength: 35 }),
        fc.integer(),
        fc.shuffledSubarray([0, 1, 2], { minLength: 3, maxLength: 3 }),
        (actions, seed, pushOrder) => {
          const simulator = new SyncSimulator(3)
          actions.forEach((action, index) => {
            const token = `${action.kind}-${index}-${action.value}`
            switch (action.kind) {
              case "append":
                simulator.append(action.device, token)
                break
              case "replace":
                simulator.replace(action.device, token)
                break
              case "rename":
                simulator.rename(action.device, `folder-${action.value % 7}/note-${index}.md`)
                break
              case "delete":
                simulator.delete(action.device)
                break
              case "binary":
                simulator.writeBinary(
                  action.device,
                  new Uint8Array([index & 0xff, action.value & 0xff, (action.value >>> 8) & 0xff]),
                )
                break
            }
          })

          simulator.pushAll(pushOrder)
          const delivery = shuffledCursors(simulator.server.changes().length, seed)
          simulator.synchronizeAll(delivery)

          const expectedVisible = simulator.visible(0)
          const expectedHeads = simulator.headIds(0)
          for (let device = 0; device < simulator.deviceCount; device += 1) {
            expect(simulator.visible(device)).toEqual(expectedVisible)
            expect(simulator.headIds(device)).toEqual(expectedHeads)
            expect(() => simulator.assertNoSilentLoss(device)).not.toThrow()
          }
        },
      ),
      { numRuns: 200 },
    )
  })

  it("preserves an edit concurrent with deletion as recovered content", () => {
    const simulator = new SyncSimulator(2)
    simulator.delete(0)
    simulator.append(1, "irreplaceable-phone-edit")
    simulator.pushAll([1, 0])
    simulator.synchronizeAll(shuffledCursors(simulator.server.changes().length, 42))

    const visible = simulator.visible(0)
    expect(visible).toHaveLength(1)
    expect(visible[0]?.kind).toBe("recovered")
    const decoded = new TextDecoder().decode(hexToBytes(required(visible[0]).contentHex))
    expect(decoded).toContain("irreplaceable-phone-edit")
    expect(simulator.visible(1)).toEqual(visible)
  })

  it("exposes both concurrent rename choices", () => {
    const simulator = new SyncSimulator(2)
    simulator.rename(0, "alpha.md")
    simulator.rename(1, "beta.md")
    simulator.synchronizeAll()

    const visible = simulator.visible(0)
    expect(visible.map((entry) => entry.path)).toEqual([
      "alpha.md",
      expect.stringContaining("beta.meridian-rename-"),
    ])
    expect(visible.some((entry) => entry.kind === "rename-conflict")).toBe(true)
    expect(simulator.visible(1)).toEqual(visible)
  })

  it("preserves every concurrent binary head", () => {
    const simulator = new SyncSimulator(3)
    simulator.writeBinary(0, new Uint8Array([1]))
    simulator.writeBinary(1, new Uint8Array([2]))
    simulator.writeBinary(2, new Uint8Array([3]))
    simulator.synchronizeAll()

    const visible = simulator.visible(0)
    expect(visible).toHaveLength(3)
    expect(new Set(visible.map((entry) => entry.contentHex))).toEqual(new Set(["01", "02", "03"]))
    expect(() => simulator.assertNoSilentLoss(0)).not.toThrow()
  })
})
