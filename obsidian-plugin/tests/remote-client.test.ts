import type { RequestUrlParam } from "obsidian"
import { describe, expect, it } from "vitest"
import {
  type HttpResponse,
  type HttpTransport,
  MeridianRemoteClient,
  normalizeEndpoint,
} from "../src/network/remote-client"
import { MeridianHttpError } from "../src/network/response-parsers"
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
      response({ sessionToken: "session-token", expiresAt: Number.MAX_SAFE_INTEGER }),
      response({
        latestCursor: 1,
        operations: [
          {
            cursor: 1,
            operationId: "operation-id",
            authorDeviceId: "remote-device",
            epochId: "epoch-id",
            type: "revision",
            envelope: "encrypted-envelope",
            signature: "signature",
            previousHash: "previous-hash",
            chainHash: "chain-hash",
            committedAt: 1,
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

  it("does not retry a rejected authentication request", async () => {
    const transport = new QueueTransport([
      response({ challengeId: "challenge-id", challenge: "challenge" }),
      response(
        { error: { code: "invalid_request", message: "Request body does not match schema" } },
        400,
      ),
    ])
    const client = new MeridianRemoteClient("https://example.test", transport)

    await expect(client.authenticate(TEST_DEVICE, new FakeCrypto())).rejects.toMatchObject({
      status: 400,
      code: "invalid_request",
    })
    expect(JSON.parse(String(transport.requests[1]?.body))).toMatchObject({
      deviceId: TEST_DEVICE.deviceId,
      challengeId: "challenge-id",
    })
    expect(transport.requests).toHaveLength(2)
  })

  it("skips the device registry for an empty change page", async () => {
    const transport = new QueueTransport([
      response({ challengeId: "challenge-id", challenge: "challenge" }),
      response({ sessionToken: "session-token", expiresAt: 120_000 }),
      response({ latestCursor: 0, operations: [] }),
    ])
    const client = new MeridianRemoteClient("https://example.test", transport, () => 0)

    await client.authenticate(TEST_DEVICE, new FakeCrypto())
    await expect(client.getChanges(0, null)).resolves.toEqual({
      latestCursor: 0,
      operations: [],
    })
    expect(transport.requests.map((request) => request.url)).toEqual([
      "https://example.test/v1/auth/challenge",
      "https://example.test/v1/auth/session",
      "https://example.test/v1/changes?after=0",
    ])
  })

  it("parses authenticated storage usage conservatively", async () => {
    const transport = new QueueTransport([
      response({ challengeId: "challenge-id", challenge: "challenge" }),
      response({ sessionToken: "session-token", expiresAt: Number.MAX_SAFE_INTEGER }),
      response({
        totalBytes: 1_500,
        blobBytes: 1_000,
        databaseBytes: 500,
        blobCount: 4,
        reservedBlobBytes: 200,
        operationCount: 7,
        checkpointCount: 2,
        snapshotCount: 1,
        retentionMode: "forever",
        activeDeviceCount: 2,
        acknowledgedDeviceCount: 1,
        minimumAcknowledgedCursor: null,
        canPrune: true,
      }),
    ])
    const client = new MeridianRemoteClient("https://example.test", transport)

    await client.authenticate(TEST_DEVICE, new FakeCrypto())
    await expect(client.getStorageUsage()).resolves.toEqual({
      totalBytes: 1_500,
      blobBytes: 1_000,
      databaseBytes: 500,
      blobCount: 4,
      reservedBlobBytes: 200,
      operationCount: 7,
      checkpointCount: 2,
      snapshotCount: 1,
      retentionMode: "forever",
      activeDeviceCount: 2,
      acknowledgedDeviceCount: 1,
      minimumAcknowledgedCursor: null,
      pruningAvailable: true,
    })
    expect(transport.requests.at(-1)?.url).toBe("https://example.test/v1/storage")
  })

  it("publishes a signed retention acknowledgement", async () => {
    const transport = new QueueTransport([
      response({ challengeId: "challenge-id", challenge: "challenge" }),
      response({ sessionToken: "session-token", expiresAt: Number.MAX_SAFE_INTEGER }),
      response({ acknowledged: true, duplicate: false, cursor: 7 }),
    ])
    const client = new MeridianRemoteClient("https://example.test", transport)

    await client.authenticate(TEST_DEVICE, new FakeCrypto())
    await client.acknowledgeRetention({
      deviceId: TEST_DEVICE.deviceId,
      cursor: 7,
      logHash: "hash-7",
      epochId: TEST_DEVICE.epochId,
      historyRetention: "forever",
      signature: "signature",
    })

    expect(transport.requests.at(-1)).toMatchObject({
      url: "https://example.test/v1/retention/acknowledgement",
      method: "PUT",
    })
  })

  it("requests owner-authorized orphan cleanup", async () => {
    const transport = new QueueTransport([
      response({ challengeId: "challenge-id", challenge: "challenge" }),
      response({ sessionToken: "session-token", expiresAt: Number.MAX_SAFE_INTEGER }),
      response({ deletedBytes: 2_048, deletedCount: 2, graceDays: 7 }),
    ])
    const client = new MeridianRemoteClient("https://example.test", transport)

    await client.authenticate(TEST_DEVICE, new FakeCrypto())
    await expect(client.pruneStorage()).resolves.toEqual({
      deletedBytes: 2_048,
      deletedCount: 2,
      graceDays: 7,
    })
    expect(transport.requests.at(-1)).toMatchObject({
      url: "https://example.test/v1/storage/prune-orphans",
      method: "POST",
    })
  })

  it("refreshes a session before it enters the expiry margin", async () => {
    let now = 0
    const transport = new QueueTransport([
      response({ challengeId: "challenge-1", challenge: "nonce-1" }),
      response({ sessionToken: "session-1", expiresAt: 120_000 }),
      response({ challengeId: "challenge-2", challenge: "nonce-2" }),
      response({ sessionToken: "session-2", expiresAt: 300_000 }),
      response({ latestCursor: 0, operations: [] }),
    ])
    const client = new MeridianRemoteClient("https://example.test", transport, () => now)

    await client.authenticate(TEST_DEVICE, new FakeCrypto())
    now = 60_001
    await client.getChanges(0, null)

    expect(transport.requests.map((request) => request.url)).toEqual([
      "https://example.test/v1/auth/challenge",
      "https://example.test/v1/auth/session",
      "https://example.test/v1/auth/challenge",
      "https://example.test/v1/auth/session",
      "https://example.test/v1/changes?after=0",
    ])
    expect(transport.requests.at(-1)?.headers?.authorization).toBe("Bearer session-2")
  })

  it("shares one proactive refresh across concurrent authenticated requests", async () => {
    let now = 0
    const transport = new QueueTransport([
      response({ challengeId: "challenge-1", challenge: "nonce-1" }),
      response({ sessionToken: "session-1", expiresAt: 120_000 }),
      response({ challengeId: "challenge-2", challenge: "nonce-2" }),
      response({ sessionToken: "session-2", expiresAt: 300_000 }),
      response({ latestCursor: 0, operations: [] }),
      response({ latestCursor: 0, operations: [] }),
    ])
    const client = new MeridianRemoteClient("https://example.test", transport, () => now)

    await client.authenticate(TEST_DEVICE, new FakeCrypto())
    now = 60_001
    await Promise.all([client.getChanges(0, null), client.getChanges(0, null)])

    expect(
      transport.requests.filter((request) => request.url.endsWith("/v1/auth/challenge")),
    ).toHaveLength(2)
    expect(
      transport.requests.filter((request) => request.url.endsWith("/v1/auth/session")),
    ).toHaveLength(2)
    expect(
      transport.requests
        .filter((request) => request.url.includes("/v1/changes"))
        .every((request) => request.headers?.authorization === "Bearer session-2"),
    ).toBe(true)
  })

  it("never installs a session created for a superseded device", async () => {
    const transport = new QueueTransport([
      response({ challengeId: "challenge-1", challenge: "nonce-1" }),
      response({ challengeId: "challenge-2", challenge: "nonce-2" }),
      response({ sessionToken: "session-1", expiresAt: Number.MAX_SAFE_INTEGER }),
      response({ sessionToken: "session-2", expiresAt: Number.MAX_SAFE_INTEGER }),
      response({ latestCursor: 0, operations: [] }),
    ])
    const client = new MeridianRemoteClient("https://example.test", transport)
    const replacementDevice = { ...TEST_DEVICE, deviceId: "replacement-device" }

    const [first, second] = await Promise.allSettled([
      client.authenticate(TEST_DEVICE, new FakeCrypto()),
      client.authenticate(replacementDevice, new FakeCrypto()),
    ])

    expect(first.status).toBe("rejected")
    expect(second.status).toBe("fulfilled")
    await client.getChanges(0, null)
    expect(transport.requests.at(-1)?.headers?.authorization).toBe("Bearer session-2")
  })

  it("reauthenticates and replays an authenticated request once after a 401", async () => {
    const transport = new QueueTransport([
      response({ challengeId: "challenge-1", challenge: "nonce-1" }),
      response({ sessionToken: "session-1", expiresAt: Number.MAX_SAFE_INTEGER }),
      response({ error: { code: "invalid_session", message: "Session expired" } }, 401),
      response({ challengeId: "challenge-2", challenge: "nonce-2" }),
      response({ sessionToken: "session-2", expiresAt: Number.MAX_SAFE_INTEGER }),
      response({ latestCursor: 0, operations: [] }),
    ])
    const client = new MeridianRemoteClient("https://example.test", transport)

    await client.authenticate(TEST_DEVICE, new FakeCrypto())
    await expect(client.getChanges(0, null)).resolves.toEqual({
      latestCursor: 0,
      operations: [],
    })

    expect(transport.requests.map((request) => request.url)).toEqual([
      "https://example.test/v1/auth/challenge",
      "https://example.test/v1/auth/session",
      "https://example.test/v1/changes?after=0",
      "https://example.test/v1/auth/challenge",
      "https://example.test/v1/auth/session",
      "https://example.test/v1/changes?after=0",
    ])
    expect(transport.requests[2]?.headers?.authorization).toBe("Bearer session-1")
    expect(transport.requests[5]?.headers?.authorization).toBe("Bearer session-2")
  })

  it("stops after one authenticated replay when the replacement session is rejected", async () => {
    const transport = new QueueTransport([
      response({ challengeId: "challenge-1", challenge: "nonce-1" }),
      response({ sessionToken: "session-1", expiresAt: Number.MAX_SAFE_INTEGER }),
      response({ error: { code: "invalid_session", message: "Session expired" } }, 401),
      response({ challengeId: "challenge-2", challenge: "nonce-2" }),
      response({ sessionToken: "session-2", expiresAt: Number.MAX_SAFE_INTEGER }),
      response({ error: { code: "invalid_session", message: "Still rejected" } }, 401),
    ])
    const client = new MeridianRemoteClient("https://example.test", transport)

    await client.authenticate(TEST_DEVICE, new FakeCrypto())
    await expect(client.getChanges(0, null)).rejects.toMatchObject({
      status: 401,
      code: "invalid_session",
    })
    expect(transport.requests).toHaveLength(6)
  })

  it("accepts an empty successful blob upload response", async () => {
    const transport = new QueueTransport([
      response({ challengeId: "challenge-id", challenge: "challenge" }),
      response({ sessionToken: "session-token", expiresAt: Number.MAX_SAFE_INTEGER }),
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

  it("reauthenticates and replays a blob upload once after a 401", async () => {
    const transport = new QueueTransport([
      response({ challengeId: "challenge-1", challenge: "nonce-1" }),
      response({ sessionToken: "session-1", expiresAt: Number.MAX_SAFE_INTEGER }),
      response({ error: { code: "invalid_session", message: "Session expired" } }, 401),
      response({ challengeId: "challenge-2", challenge: "nonce-2" }),
      response({ sessionToken: "session-2", expiresAt: Number.MAX_SAFE_INTEGER }),
      emptyResponse(201),
    ])
    const client = new MeridianRemoteClient("https://example.test", transport)
    const bytes = new ArrayBuffer(4)

    await client.authenticate(TEST_DEVICE, new FakeCrypto())
    await expect(
      client.putBlob({ blobId: "blob-id", bytes, chunkIndex: 0 }),
    ).resolves.toBeUndefined()

    expect(transport.requests[2]).toMatchObject({
      url: "https://example.test/v1/blobs/blob-id",
      body: bytes,
      headers: {
        authorization: "Bearer session-1",
        "content-type": "application/octet-stream",
      },
    })
    expect(transport.requests[5]).toMatchObject({
      url: "https://example.test/v1/blobs/blob-id",
      body: bytes,
      headers: {
        authorization: "Bearer session-2",
        "content-type": "application/octet-stream",
      },
    })
  })

  it("submits signed revocations to the selected device route", async () => {
    const transport = new QueueTransport([
      response({ challengeId: "challenge-id", challenge: "challenge" }),
      response({ sessionToken: "session-token", expiresAt: Number.MAX_SAFE_INTEGER }),
      response({ cursor: 7, chainHash: "chain-hash" }, 201),
    ])
    const client = new MeridianRemoteClient("https://example.test", transport)
    await client.authenticate(TEST_DEVICE, new FakeCrypto())

    await expect(client.revokeDevice("old-device", { signature: "signed" })).resolves.toEqual({
      cursor: 7,
      logHash: "chain-hash",
    })
    expect(transport.requests.at(-1)).toMatchObject({
      method: "POST",
      url: "https://example.test/v1/devices/old-device/revoke",
      body: JSON.stringify({ operation: { signature: "signed" } }),
      headers: { authorization: "Bearer session-token", "content-type": "application/json" },
    })
  })

  it("distinguishes active and revoked device identities", async () => {
    const activeTransport = new QueueTransport([
      response({ challengeId: "id", challenge: "nonce" }),
    ])
    const revokedTransport = new QueueTransport([
      response({ error: { code: "device_not_found" } }, 404),
    ])
    const ambiguousTransport = new QueueTransport([response({ message: "Not found" }, 404)])

    await expect(
      new MeridianRemoteClient("https://example.test", activeTransport).isDeviceAuthorized(
        "device-id",
      ),
    ).resolves.toBe(true)
    await expect(
      new MeridianRemoteClient("https://example.test", revokedTransport).isDeviceAuthorized(
        "device-id",
      ),
    ).resolves.toBe(false)
    await expect(
      new MeridianRemoteClient("https://example.test", ambiguousTransport).isDeviceAuthorized(
        "device-id",
      ),
    ).rejects.toThrow(/invalid not-found response/)
  })

  it("preserves exact Worker error codes for conservative recovery", async () => {
    const client = new MeridianRemoteClient(
      "https://example.test",
      new QueueTransport([
        response({ error: { code: "pairing_expired", message: "Pairing request expired" } }, 410),
      ]),
    )

    const error = await client.completePairing("pairing-id", {}).catch((caught) => caught)
    expect(error).toBeInstanceOf(MeridianHttpError)
    expect(error).toMatchObject({ status: 410, code: "pairing_expired" })
  })

  it("polls relayed pairing state without consuming the result", async () => {
    const transport = new QueueTransport([
      response({ challengeId: "challenge-id", challenge: "challenge" }),
      response({ sessionToken: "session-token", expiresAt: Number.MAX_SAFE_INTEGER }),
      response({
        pairingId: "pairing-id",
        status: "joined",
        expiresAt: 1_000,
        ownerConfirmed: false,
        candidateConfirmed: false,
        relayAvailable: true,
        candidate: {
          pairingId: "pairing-id",
          vaultId: "vault-id",
          expiresAt: 1_000,
          deviceId: "candidate-id",
          signingPublicKey: "signing-key",
          hpkePublicKey: "hpke-key",
          deviceName: "Test iPhone",
          platform: "iOS",
          requestProof: "request-proof",
        },
      }),
      response({
        pairingId: "pairing-id",
        status: "verifying",
        expiresAt: 1_000,
        ownerConfirmed: false,
        candidateConfirmed: false,
      }),
    ])
    const client = new MeridianRemoteClient("https://example.test", transport)

    await client.authenticate(TEST_DEVICE, new FakeCrypto())
    const relayed = await client.getPairingStatus("pairing-id")
    const progress = await client.getPairingProgress("pairing-id", "capability")

    expect(JSON.parse(relayed.candidatePackage ?? "null")).toMatchObject({
      pairingId: "pairing-id",
      deviceId: "candidate-id",
      requestProof: "request-proof",
    })
    expect(progress.status).toBe("verifying")
    expect(transport.requests[2]?.headers?.authorization).toBe("Bearer session-token")
    expect(transport.requests[3]?.headers?.authorization).toBeUndefined()
    expect(transport.requests[3]?.body).toBe(JSON.stringify({ capability: "capability" }))
  })

  it("uses the public bounded recovery endpoints without a session", async () => {
    const transport = new QueueTransport([
      response({ encryptedRecoveryPackage: "package", recoveryStateId: "state-id" }),
      response({ challengeId: "challenge", challenge: "nonce" }),
      response({ recoveredAt: 1 }, 201),
    ])
    const client = new MeridianRemoteClient("https://example.test", transport)

    await expect(client.getRecoveryPackage()).resolves.toEqual({
      encryptedRecoveryPackage: "package",
      recoveryStateId: "state-id",
    })
    await expect(client.createRecoveryChallenge()).resolves.toEqual({
      challengeId: "challenge",
      challenge: "nonce",
    })
    await expect(client.recover({ proof: "proof" })).resolves.toBeUndefined()
    expect(transport.requests.every((request) => !request.headers?.authorization)).toBe(true)
  })
})
