import { describe, expect, it } from "vitest"
import { DEFAULT_SETTINGS, INITIAL_STATUS } from "../src/model"
import { presentQuickStatus } from "../src/ui/quick-status-presentation"

const configured = {
  ...structuredClone(DEFAULT_SETTINGS),
  endpoint: "https://example.test",
  vaultId: "vault-id",
  deviceId: "device-id",
}

describe("quick status menu presentation", () => {
  it("offers compact sync and inspection actions without zero-queue noise", () => {
    const presentation = presentQuickStatus(
      configured,
      { ...INITIAL_STATUS, phase: "idle", message: "Up to date", socketConnected: true },
      true,
    )

    expect(presentation).toMatchObject({
      title: "Up to date",
      detail: "Connected",
      icon: "cloud-check",
    })
    expect(presentation.actions.map((action) => action.id)).toEqual([
      "sync",
      "pause",
      "activity",
      "history",
      "conflicts",
      "devices",
      "status",
      "settings",
    ])
    expect(presentation.actions.find((action) => action.id === "sync")?.disabled).toBe(false)
  })

  it("disables manual sync while work is active", () => {
    const presentation = presentQuickStatus(
      configured,
      { ...INITIAL_STATUS, phase: "pulling", message: "Downloading changes" },
      false,
    )

    expect(presentation.actions.find((action) => action.id === "sync")?.disabled).toBe(true)
    expect(presentation.actions.some((action) => action.id === "history")).toBe(false)
    expect(presentation.actions.find((action) => action.id === "activity")?.disabled).toBe(false)
  })

  it("reduces an unconfigured vault to setup and inspection entry points", () => {
    const presentation = presentQuickStatus(DEFAULT_SETTINGS, INITIAL_STATUS, false)

    expect(presentation.actions.map((action) => [action.id, action.disabled])).toEqual([
      ["activity", true],
      ["conflicts", true],
      ["devices", true],
      ["status", false],
      ["settings", false],
    ])
    expect(presentation.actions.at(-1)?.title).toBe("Connect Meridian")
  })
})
