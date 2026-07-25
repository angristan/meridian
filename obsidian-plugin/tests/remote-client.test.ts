import type { RequestUrlParam } from "obsidian"
import { describe, expect, it } from "vitest"
import {
  type HttpResponse,
  type HttpTransport,
  MeridianRemoteClient,
  normalizeEndpoint,
} from "../src/network/remote-client"
import { FakeCrypto, TEST_DEVICE } from "./fakes"

class QueueTransport implements HttpTransport {
  readonly requests: RequestUrlParam[] = []

  constructor(private readonly responses: HttpResponse[]) {}

  async request(request: RequestUrlParam): Promise<HttpResponse> {
    this.requests.push(request)
    const response = this.responses.shift()
    if (!response) throw new Error("Missing queued response")
    return response
  }
}

function response(json: unknown, status = 200): HttpResponse {
  return {
    status,
    headers: {},
    body: new ArrayBuffer(0),
    text: JSON.stringify(json),
  }
}

function emptyResponse(status: number): HttpResponse {
  return {
    status,
    headers: {},
    body: new ArrayBuffer(0),
    text: "",
  }
}

describe("Meridian remote client", () => {
  it("normalizes only safe HTTPS or loopback endpoints", () => {
    expect(normalizeEndpoint("https://example.test/relay/")).toBe("https://example.test/relay")
    expect(normalizeEndpoint("http://localhost:8787/")).toBe("http://localhost:8787")
    expect(() => normalizeEndpoint("http://example.test")).toThrow(/HTTPS/)
    expect(() => normalizeEndpoint("https://user@example.test")).toThrow(/credentials/)
  })

  it("authenticates and decorates operations with registry certificates", async () => {
    const transport = new QueueTransport([
      response({ challengeId: "challenge-id", challenge: "challenge" }),
      response({ sessionToken: "session-token" }),
      response({
        latestCursor: 1,
        operations: [
          {
            cursor: 1,
            chainHash: "chain-hash",
            authorDeviceId: "remote-device",
            envelope: "encrypted-envelope",
          },
        ],
      }),
      response({
        devices: [
          {
            deviceId: "remote-device",
            signingPublicKey: "signing-key",
            hpkePublicKey: "hpke-key",
            certificate: "certificate",
            role: "member",
            authorizedAt: 1,
            revokedAt: null,
          },
        ],
      }),
    ])
    const client = new MeridianRemoteClient("https://example.test", transport)

    await client.authenticate(TEST_DEVICE, new FakeCrypto())
    const changes = await client.getChanges(0, null)

    expect(changes.latestCursor).toBe(1)
    expect(changes.operations[0]).toMatchObject({
      cursor: 1,
      logHash: "chain-hash",
      authorCertificate: "certificate",
      certificateChain: ["certificate"],
    })
    expect(transport.requests.map((request) => request.url)).toEqual([
      "https://example.test/v1/auth/challenge",
      "https://example.test/v1/auth/session",
      "https://example.test/v1/changes?after=0",
      "https://example.test/v1/devices",
    ])
    expect(transport.requests[2]?.headers).toMatchObject({
      authorization: "Bearer session-token",
    })
  })

  it("accepts an empty successful blob upload response", async () => {
    const transport = new QueueTransport([
      response({ challengeId: "challenge-id", challenge: "challenge" }),
      response({ sessionToken: "session-token" }),
      emptyResponse(201),
    ])
    const client = new MeridianRemoteClient("https://example.test", transport)

    await client.authenticate(TEST_DEVICE, new FakeCrypto())
    await expect(
      client.putBlob({ blobId: "blob-id", bytes: new ArrayBuffer(4), chunkIndex: 0 }),
    ).resolves.toBeUndefined()
    expect(transport.requests.at(-1)).toMatchObject({
      method: "PUT",
      url: "https://example.test/v1/blobs/blob-id",
    })
  })

  it("uses the public bounded recovery endpoints without a session", async () => {
    const transport = new QueueTransport([
      response({ encryptedRecoveryPackage: "package" }),
      response({ challengeId: "challenge", challenge: "nonce" }),
      response({ recoveredAt: 1 }, 201),
    ])
    const client = new MeridianRemoteClient("https://example.test", transport)

    await expect(client.getRecoveryPackage()).resolves.toBe("package")
    await expect(client.createRecoveryChallenge()).resolves.toEqual({
      challengeId: "challenge",
      challenge: "nonce",
    })
    await expect(client.recover({ proof: "proof" })).resolves.toBeUndefined()
    expect(transport.requests.every((request) => !request.headers?.authorization)).toBe(true)
  })
})
