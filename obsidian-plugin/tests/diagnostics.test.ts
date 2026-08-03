import { describe, expect, it } from "vitest"
import { DEFAULT_SETTINGS, INITIAL_STATUS } from "../src/model"
import { createSanitizedDebugReport, SyncDiagnostics } from "../src/plugin/diagnostics"

describe("sync diagnostics", () => {
  it("deduplicates status transitions and keeps a bounded newest-first session log", () => {
    let now = 0
    const diagnostics = new SyncDiagnostics(2, () => ++now)
    diagnostics.record({ ...INITIAL_STATUS, phase: "scanning", message: "Checking local changes" })
    diagnostics.record({ ...INITIAL_STATUS, phase: "scanning", message: "Checking local changes" })
    diagnostics.record({
      ...INITIAL_STATUS,
      phase: "pulling",
      message: "Downloading changes",
      error: "Failed Secret/medical.md for private-device-id",
    })
    diagnostics.record({ ...INITIAL_STATUS, phase: "idle", message: "Up to date" })

    const entries = diagnostics.entries()
    expect(entries).toEqual([
      expect.objectContaining({ timestamp: 3, phase: "idle" }),
      expect.objectContaining({ timestamp: 2, phase: "pulling", error: "Error recorded" }),
    ])
    expect(JSON.stringify(entries)).not.toContain("medical.md")
    expect(JSON.stringify(entries)).not.toContain("private-device-id")
  })

  it("copies useful state without endpoints, identifiers, paths, or error details", () => {
    const settings = {
      ...structuredClone(DEFAULT_SETTINGS),
      endpoint: "https://private-worker.example.test",
      vaultId: "private-vault-id",
      deviceId: "private-device-id",
    }
    const status = {
      ...INITIAL_STATUS,
      phase: "error" as const,
      cursor: 42,
      queued: 2,
      error: "Failed to sync Secret/medical.md for private-device-id",
    }
    const report = createSanitizedDebugReport(
      {
        meridianVersion: "1.2.3",
        obsidianVersion: "1.13.4",
        platform: "macOS",
        settings,
      },
      status,
      [
        {
          timestamp: 1,
          phase: "error",
          message: "Failed Secret/medical.md for private-device-id",
          error: status.error,
        },
      ],
    )

    expect(report).toContain('"cursor": 42')
    expect(report).toContain('"hasError": true')
    expect(report).not.toContain("private-worker")
    expect(report).not.toContain("private-vault-id")
    expect(report).not.toContain("private-device-id")
    expect(report).not.toContain("medical.md")
    expect(report).not.toContain("Sync needs attention")
  })
})
