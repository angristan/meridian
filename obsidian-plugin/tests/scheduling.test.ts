import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { FakeTFile } = vi.hoisted(() => ({
  FakeTFile: class {
    constructor(readonly path: string) {}
  },
}))

vi.mock("obsidian", () => ({ TFile: FakeTFile }))

import type { MeridianSettings, SyncStatus } from "../src/model"
import { DEFAULT_SETTINGS, INITIAL_STATUS } from "../src/model"
import { PluginScheduling } from "../src/plugin/scheduling"
import type { SyncController } from "../src/sync/controller"

interface SchedulingHarness {
  scheduling: PluginScheduling
  controller: SyncController
  status: SyncStatus
  vaultEvents: Map<string, (...args: unknown[]) => void>
  domEvents: Map<string, () => void>
  setVisibility(state: "hidden" | "visible"): void
}

function harness(
  settings: MeridianSettings = structuredClone(DEFAULT_SETTINGS),
): SchedulingHarness {
  const vaultEvents = new Map<string, (...args: unknown[]) => void>()
  const domEvents = new Map<string, () => void>()
  let visibilityState: "hidden" | "visible" = "visible"
  const documentTarget = {
    get visibilityState() {
      return visibilityState
    },
  }
  const windowTarget = {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  }
  vi.stubGlobal("document", documentTarget)
  vi.stubGlobal("window", windowTarget)
  vi.stubGlobal("navigator", { onLine: true })

  const status: SyncStatus = {
    ...INITIAL_STATUS,
    phase: "idle",
    socketConnected: true,
    lastSyncedAt: Date.now(),
  }
  const controller = {
    getStatus: () => ({ ...status }),
    sync: vi.fn(async () => {
      status.phase = "idle"
      status.lastSyncedAt = Date.now()
    }),
    resume: vi.fn(async () => {}),
    reconnectNotifications: vi.fn(),
    recordVaultChange: vi.fn(async () => {}),
  } as unknown as SyncController
  const plugin = {
    app: {
      vault: {
        configDir: ".obsidian",
        on: (event: string, callback: (...args: unknown[]) => void) => {
          vaultEvents.set(event, callback)
          return { event }
        },
      },
    },
    registerEvent: () => {},
    registerDomEvent: (target: unknown, event: string, callback: () => void) => {
      domEvents.set(`${target === documentTarget ? "document" : "window"}:${event}`, callback)
    },
    register: () => {},
  }
  const scheduling = new PluginScheduling(
    plugin as never,
    () => controller,
    () => settings,
    { now: () => Date.now(), random: () => 0.5 },
  )
  scheduling.register()
  scheduling.statusChanged({ socketConnected: true })
  scheduling.connectionStarted()
  return {
    scheduling,
    controller,
    status,
    vaultEvents,
    domEvents,
    setVisibility: (state) => {
      visibilityState = state
    },
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_700_000_000_000)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("plugin scheduling", () => {
  it("uses one exact timer and coalesces simultaneous scan and poll deadlines", async () => {
    const context = harness()
    expect(vi.getTimerCount()).toBe(1)

    await vi.advanceTimersByTimeAsync(5 * 60_000)

    expect(context.controller.sync).toHaveBeenCalledTimes(1)
    expect(context.controller.sync).toHaveBeenCalledWith("interval")
    expect(vi.getTimerCount()).toBe(1)
    context.scheduling.stop()
    vi.useRealTimers()
  })

  it("flushes a pending file event before suspension", async () => {
    const context = harness()
    context.vaultEvents.get("modify")?.(new FakeTFile("note.md"))

    context.setVisibility("hidden")
    context.domEvents.get("document:visibilitychange")?.()
    for (let index = 0; index < 10; index += 1) await Promise.resolve()

    expect(context.controller.sync).toHaveBeenCalledWith("file-event")
    expect(vi.getTimerCount()).toBe(0)
    context.scheduling.stop()
    vi.useRealTimers()
  })

  it("coalesces duplicate visible, pageshow, and online resume events", async () => {
    const context = harness()
    context.domEvents.get("document:visibilitychange")?.()
    context.domEvents.get("window:pageshow")?.()
    context.domEvents.get("window:online")?.()

    expect(context.controller.resume).toHaveBeenCalledTimes(1)
    for (let index = 0; index < 5; index += 1) await Promise.resolve()
    expect(vi.getTimerCount()).toBe(1)
    context.scheduling.stop()
    vi.useRealTimers()
  })

  it("drains durable file events before a manual sync without a duplicate sync", async () => {
    const context = harness()
    context.vaultEvents.get("modify")?.(new FakeTFile("note.md"))

    await context.scheduling.flushPendingFileEvents()

    expect(context.controller.recordVaultChange).toHaveBeenCalledWith("note.md")
    expect(context.controller.sync).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(1)
    context.scheduling.stop()
    vi.useRealTimers()
  })
})
