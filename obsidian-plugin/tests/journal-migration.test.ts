import { describe, expect, it } from "vitest"
import { DATABASE_VERSION } from "../src/storage/migration"

describe("journal schema", () => {
  it("keeps the current IndexedDB version", () => {
    expect(DATABASE_VERSION).toBe(6)
  })
})
