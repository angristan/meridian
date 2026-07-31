import { readFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"

const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8")

function cssRule(selector: string): string {
  const start = styles.indexOf(`${selector} {`)
  if (start < 0) throw new Error(`Missing CSS rule for ${selector}`)
  const end = styles.indexOf("}", start)
  if (end < 0) throw new Error(`Unclosed CSS rule for ${selector}`)
  return styles.slice(start, end)
}

describe("revision history layout", () => {
  it("allows multi-line revision buttons to size to their content", () => {
    const rule = cssRule(".meridian-history-item")

    expect(rule).toContain("display: grid")
    expect(rule).toContain("height: auto")
    expect(rule).toContain("min-height: 0")
    expect(rule).toContain("white-space: normal")
  })

  it("keeps detail actions separate and stacks the layout on mobile", () => {
    expect(cssRule(".meridian-history-detail-header")).toContain("display: grid")
    expect(cssRule(".is-mobile .meridian-history-layout")).toContain("grid-template-columns: 1fr")
    expect(cssRule(".is-mobile .meridian-history-layout")).toContain("height: auto")
  })
})
