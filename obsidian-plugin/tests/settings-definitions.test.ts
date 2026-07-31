import { beforeAll, describe, expect, it, vi } from "vitest"
import { DEFAULT_SETTINGS, INITIAL_STATUS } from "../src/model"

vi.mock("obsidian", () => ({
  Modal: class {},
  Notice: class {},
  Setting: class {},
}))

describe("Obsidian 1.13 setting definitions", () => {
  let getDefinitions: typeof import("../src/ui/settings")["getMeridianSettingDefinitions"]

  beforeAll(async () => {
    ;({ getMeridianSettingDefinitions: getDefinitions } = await import("../src/ui/settings"))
  })

  it("indexes every major Meridian settings area for search", () => {
    const host = {
      settings: structuredClone(DEFAULT_SETTINGS),
      getStatus: () => INITIAL_STATUS,
    }
    const definitions = getDefinitions(host as never, () => {})
    const names = definitions.flatMap((definition) =>
      "items" in definition && definition.items
        ? definition.items.map((item) => ("name" in item ? item.name : ""))
        : "name" in definition
          ? [definition.name]
          : [],
    )

    expect(names).toEqual(
      expect.arrayContaining([
        "Connection",
        "Device name",
        "Excluded folders",
        "Excluded file extensions",
        "Themes and CSS snippets",
        "Polling interval",
        "Attachment size limit",
        "Storage usage",
        "Automatic pruning",
        "Recover vault ownership",
        "Rebuild local index",
      ]),
    )
    expect(definitions).toHaveLength(6)
  })
})
