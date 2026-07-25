import type { RequestUrlResponse } from "obsidian"
import { beforeEach, describe, expect, it, vi } from "vitest"

const { requestUrlMock } = vi.hoisted(() => ({ requestUrlMock: vi.fn() }))

vi.mock("obsidian", () => ({ requestUrl: requestUrlMock }))

import { ObsidianHttpTransport } from "../src/network/obsidian-transport"

describe("Obsidian HTTP transport", () => {
  beforeEach(() => requestUrlMock.mockReset())

  it("does not access the JSON getter for an empty response", async () => {
    const response = {
      status: 201,
      headers: {},
      arrayBuffer: new ArrayBuffer(0),
      text: "",
    }
    Object.defineProperty(response, "json", {
      get: () => {
        throw new SyntaxError("Unexpected end of JSON input")
      },
    })
    requestUrlMock.mockResolvedValue(response as RequestUrlResponse)

    await expect(
      new ObsidianHttpTransport().request({
        url: "https://example.test/v1/blobs/blob-id",
        method: "PUT",
        throw: false,
      }),
    ).resolves.toEqual({
      status: 201,
      headers: {},
      body: new ArrayBuffer(0),
      text: "",
    })
  })
})
