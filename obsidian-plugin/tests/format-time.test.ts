import { describe, expect, it } from "vitest"
import { formatRelativeTime } from "../src/ui/format-time"

const NOW = Date.UTC(2026, 6, 31, 12)

describe("relative time formatting", () => {
  it("keeps recent synchronization times concise", () => {
    expect(formatRelativeTime(NOW, NOW)).toBe("just now")
    expect(formatRelativeTime(NOW - 44_000, NOW)).toBe("just now")
    expect(formatRelativeTime(NOW - 60_000, NOW)).toBe("1 min ago")
    expect(formatRelativeTime(NOW - 12 * 60_000, NOW)).toBe("12 min ago")
    expect(formatRelativeTime(NOW - 3 * 60 * 60_000, NOW)).toBe("3 hr ago")
    expect(formatRelativeTime(NOW - 4 * 24 * 60 * 60_000, NOW)).toBe("4 days ago")
  })

  it("treats future timestamps as just synchronized", () => {
    expect(formatRelativeTime(NOW + 60_000, NOW)).toBe("just now")
  })
})
