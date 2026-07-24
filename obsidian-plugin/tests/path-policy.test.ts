import { describe, expect, it } from "vitest"
import { DEFAULT_SETTINGS } from "../src/model"
import {
  configCategoryForPath,
  conflictPath,
  isSyncablePath,
  normalizeVaultPath,
} from "../src/vault/path-policy"

const selected = DEFAULT_SETTINGS.configCategories

describe("path policy", () => {
  it("uses the active config directory and a strict allowlist", () => {
    expect(configCategoryForPath(".settings/app.json", ".settings")).toBe("main")
    expect(configCategoryForPath(".settings/themes/Night/theme.css", ".settings")).toBe("themes")
    expect(isSyncablePath(".settings/hotkeys.json", ".settings", selected)).toBe(true)
    expect(isSyncablePath(".settings/workspace-mobile.json", ".settings", selected)).toBe(false)
    expect(isSyncablePath(".settings/plugins/example/data.json", ".settings", selected)).toBe(false)
  })

  it("always excludes secrets, temporary files, and hidden vault paths", () => {
    expect(isSyncablePath("notes/.meridian/journal.json", ".obsidian", selected)).toBe(false)
    expect(isSyncablePath("secret-storage.json", ".obsidian", selected)).toBe(false)
    expect(isSyncablePath("attachments/upload.part", ".obsidian", selected)).toBe(false)
    expect(isSyncablePath(".gitignore", ".obsidian", selected)).toBe(false)
    expect(isSyncablePath(".vscode/settings.json", ".obsidian", selected)).toBe(false)
    expect(isSyncablePath("notes/.private/draft.md", ".obsidian", selected)).toBe(false)
    expect(isSyncablePath("notes/real.md", ".obsidian", selected)).toBe(true)
  })

  it("allows only allowlisted files inside a custom hidden config directory", () => {
    expect(isSyncablePath(".settings/app.json", ".settings", selected)).toBe(true)
    expect(isSyncablePath(".settings/themes/Night/theme.css", ".settings", selected)).toBe(true)
    expect(isSyncablePath(".settings/.cache/index.json", ".settings", selected)).toBe(false)
    expect(isSyncablePath(".obsidian/app.json", ".settings", selected)).toBe(false)
  })

  it("normalizes Unicode and refuses parent traversal", () => {
    expect(normalizeVaultPath("Notes\\Cafe\u0301.md")).toBe("Notes/Café.md")
    expect(() => normalizeVaultPath("../outside.md")).toThrow("Unsafe vault path")
  })

  it("keeps configuration conflicts outside the active config directory", () => {
    expect(conflictPath(".obsidian/hotkeys.json", "iphone", "revision", ".obsidian")).toBe(
      "Meridian conflicts/config/hotkeys.json.iphone-revision",
    )
  })
})
