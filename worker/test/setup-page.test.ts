import { SELF } from "cloudflare:test"
import { describe, expect, it } from "vitest"

describe("public setup surface", () => {
  it("serves health without disclosing deployment identifiers", async () => {
    const response = await SELF.fetch("https://example.test/health")
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      ok: true,
      service: "meridian",
      protocol: 1,
    })
    expect(response.headers.get("x-content-type-options")).toBe("nosniff")
  })

  it("serves a framed-denied setup page and external script", async () => {
    const page = await SELF.fetch("https://example.test/setup")
    expect(page.status).toBe(200)
    expect(page.headers.get("x-frame-options")).toBe("DENY")
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self'")
    expect(await page.text()).not.toContain("integration-test-setup-token")

    const script = await SELF.fetch("https://example.test/assets/setup.js")
    expect(script.status).toBe(200)
    expect(script.headers.get("content-type")).toContain("text/javascript")
  })

  it("rejects an invalid setup token", async () => {
    const response = await SELF.fetch("https://example.test/v1/setup/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "this-token-is-invalid-but-long-enough" }),
    })
    expect(response.status).toBe(401)
    expect(response.headers.get("cache-control")).toBe("no-store")
  })
})
