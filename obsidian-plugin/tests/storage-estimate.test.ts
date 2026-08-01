import { describe, expect, it } from "vitest"
import {
  estimateLocalStorage,
  isQuotaExceededError,
  localStoragePressure,
  requestLocalStoragePersistence,
} from "../src/platform/storage-estimate"

describe("local storage pressure", () => {
  it("works when mobile WebViews omit StorageManager APIs", async () => {
    await expect(estimateLocalStorage(null)).resolves.toEqual({
      usageBytes: null,
      quotaBytes: null,
      persisted: null,
      pressure: "unavailable",
    })
    await expect(requestLocalStoragePersistence(null)).resolves.toBeNull()
  })

  it("classifies warning and critical origin-wide usage", () => {
    expect(localStoragePressure(79, 100)).toBe("normal")
    expect(localStoragePressure(80, 100)).toBe("warning")
    expect(localStoragePressure(90, 100)).toBe("critical")
    expect(localStoragePressure(null, 100)).toBe("unavailable")
  })

  it("reports estimates and persistent-storage grants", async () => {
    const manager = {
      estimate: async () => ({ usage: 85, quota: 100 }),
      persisted: async () => false,
      persist: async () => true,
    }
    await expect(estimateLocalStorage(manager)).resolves.toEqual({
      usageBytes: 85,
      quotaBytes: 100,
      persisted: false,
      pressure: "warning",
    })
    await expect(requestLocalStoragePersistence(manager)).resolves.toBe(true)
  })

  it("recognizes current and legacy IndexedDB quota errors", () => {
    const current = new Error("full")
    current.name = "QuotaExceededError"
    const legacy = new Error("full")
    legacy.name = "NS_ERROR_DOM_QUOTA_REACHED"
    expect(isQuotaExceededError(current)).toBe(true)
    expect(isQuotaExceededError(legacy)).toBe(true)
    expect(isQuotaExceededError(new Error("network"))).toBe(false)
  })
})
