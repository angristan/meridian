import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { DEFAULT_SETTINGS, INITIAL_STATUS } from "../src/model"

const renderedSettings = vi.hoisted(
  () => [] as Array<{ control?: string; heading: boolean; name: string }>,
)

vi.mock("obsidian", () => {
  class Component {
    inputEl = { rows: 0 }
  }

  const createComponent = () =>
    new Proxy(new Component(), {
      get: (target, property, receiver) =>
        Reflect.has(target, property) ? Reflect.get(target, property, receiver) : () => receiver,
    })

  class Setting {
    controlEl = { childElementCount: 0 }
    settingEl = {}
    record = { heading: false, name: "" } as (typeof renderedSettings)[number]

    constructor() {
      renderedSettings.push(this.record)
    }
    setName(name: string) {
      this.record.name = name
      return this
    }
    setDesc() {
      return this
    }
    setHeading() {
      this.record.heading = true
      return this
    }
  }

  const controls = {
    addButton: "button",
    addDropdown: "dropdown",
    addSlider: "slider",
    addText: "text",
    addTextArea: "textarea",
    addToggle: "toggle",
  }
  for (const [method, control] of Object.entries(controls)) {
    Object.defineProperty(Setting.prototype, method, {
      value(this: Setting, callback: (component: Component) => void) {
        this.record.control = control
        callback(createComponent())
        return this
      },
    })
  }

  return { Modal: class {}, Notice: class {}, Setting }
})

describe("Obsidian 1.13 setting definitions", () => {
  let getDefinitions: typeof import("../src/ui/settings")["getMeridianSettingDefinitions"]
  let renderSettings: typeof import("../src/ui/settings")["renderSettings"]

  beforeAll(async () => {
    ;({ getMeridianSettingDefinitions: getDefinitions, renderSettings } = await import(
      "../src/ui/settings"
    ))
  })

  beforeEach(() => renderedSettings.splice(0))

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

    expect(names).toEqual([
      "Connection",
      "Devices and recovery",
      "Obsidian configuration",
      "Troubleshooting",
    ])
    expect(definitions).toHaveLength(3)
  })

  it("derives legacy rows and controls from the searchable definitions", () => {
    const settings = structuredClone(DEFAULT_SETTINGS)
    settings.enabled = true
    settings.endpoint = "https://example.test"
    settings.deviceId = "device-id"
    const host = {
      settings,
      getStatus: () => INITIAL_STATUS,
      getDevices: async () => [],
      getEpochStatus: async () => null,
    }
    const definitions = getDefinitions(host as never, () => {})
    const items = definitions
      .flatMap((definition) => ("items" in definition && definition.items ? definition.items : []))
      .filter((item) => "name" in item)
    const visibleItems = items.filter(
      (item) => !("visible" in item) || typeof item.visible !== "function" || item.visible(),
    )

    renderSettings(
      { empty: () => {}, createDiv: () => {} } as unknown as HTMLElement,
      host as never,
    )

    const rows = renderedSettings.filter((setting) => !setting.heading)
    expect(rows.map((row) => row.name)).toEqual(visibleItems.map((item) => item.name))
    expect(rows.map((row) => row.control)).toEqual(["button", "button", "button", "button"])
  })
})
