import {
  createFirstDeviceClaimBundle,
  serializeEncryptedRecoveryPackage,
  sign as signBytes,
} from "@meridian/crypto"
import { type Ed25519PrivateKey, encodeDeviceCertificate } from "@meridian/protocol"
import { env, runInDurableObject, SELF } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { base64UrlEncode, randomToken, ZERO_HASH } from "../src/encoding"
import type { Operation, PairingApproval, PairingJoin, SetupClaim } from "../src/schemas"
import {
  authSigningMessage,
  operationSigningMessage,
  pairingApprovalSigningMessage,
  pairingJoinSigningMessage,
  setupClaimSigningMessage,
} from "../src/vault-do"
import { migrateVaultSchema } from "../src/vault/migrations"

const SETUP_TOKEN = "integration-test-setup-token-32-bytes-long"

function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return bytes
}

async function createSigningKey(): Promise<CryptoKeyPair> {
  return await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])
}

async function publicKey(keyPair: CryptoKeyPair): Promise<string> {
  return base64UrlEncode(new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey)))
}

async function sign(
  keyPair: CryptoKeyPair | Ed25519PrivateKey,
  message: Uint8Array,
): Promise<string> {
  if (keyPair instanceof Uint8Array) return base64UrlEncode(signBytes(message, keyPair))
  const messageCopy = new Uint8Array(message.byteLength)
  messageCopy.set(message)
  return base64UrlEncode(
    new Uint8Array(await crypto.subtle.sign("Ed25519", keyPair.privateKey, messageCopy)),
  )
}

async function authenticateDevice(
  vaultId: string,
  deviceId: string,
  signingKey: CryptoKeyPair | Ed25519PrivateKey,
): Promise<string> {
  const challengeResponse = await SELF.fetch("https://example.test/v1/auth/challenge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceId }),
  })
  expect(challengeResponse.status).toBe(200)
  const challenge = (await challengeResponse.json()) as {
    challengeId: string
    challenge: string
  }
  const authInput = {
    deviceId,
    challengeId: challenge.challengeId,
    signature: base64UrlEncode(randomBytes(64)),
  }
  authInput.signature = await sign(
    signingKey,
    authSigningMessage(vaultId, authInput, challenge.challenge),
  )
  const sessionResponse = await SELF.fetch("https://example.test/v1/auth/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(authInput),
  })
  expect(sessionResponse.status).toBe(200)
  const session = (await sessionResponse.json()) as { sessionToken: string }
  return session.sessionToken
}

async function setupAndAuthenticate(): Promise<{
  readonly deviceId: string
  readonly sessionToken: string
  readonly signingKey: Ed25519PrivateKey
  readonly vaultId: string
}> {
  const first = await createFirstDeviceClaimBundle()
  const signingKey = first.device.signingPrivateKey
  const deviceId = base64UrlEncode(first.device.deviceId)
  const vaultId = base64UrlEncode(first.device.vaultId)
  const signingPublicKey = base64UrlEncode(first.device.signingPublicKey)

  const setupResponse = await SELF.fetch("https://example.test/v1/setup/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: SETUP_TOKEN }),
  })
  expect(setupResponse.status).toBe(200)
  const setup = (await setupResponse.json()) as {
    setupSession: string
    claimChallenge: string
  }

  const unsignedClaim: SetupClaim = {
    setupSession: setup.setupSession,
    vaultId,
    recoverySigningPublicKey: base64UrlEncode(first.recoveryPublicKey),
    encryptedRecoveryPackage: base64UrlEncode(
      serializeEncryptedRecoveryPackage(first.encryptedRecoveryPackage),
    ),
    initialDevice: {
      deviceId,
      signingPublicKey,
      hpkePublicKey: base64UrlEncode(first.device.hpkePublicKey),
      certificate: base64UrlEncode(encodeDeviceCertificate(first.device.certificate)),
    },
    proof: base64UrlEncode(randomBytes(64)),
  }
  const claim: SetupClaim = {
    ...unsignedClaim,
    proof: await sign(signingKey, setupClaimSigningMessage(unsignedClaim, setup.claimChallenge)),
  }
  const claimResponse = await SELF.fetch("https://example.test/v1/setup/claim", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(claim),
  })
  expect(claimResponse.status).toBe(201)

  const sessionToken = await authenticateDevice(vaultId, deviceId, signingKey)
  return { deviceId, sessionToken, signingKey, vaultId }
}

describe("Meridian Worker integration", () => {
  it("initializes the SQLite schema", async () => {
    const id = env.VAULT.idFromName("schema-test")
    const stub = env.VAULT.get(id)
    await runInDurableObject(stub, async (instance, state) => {
      await instance.fetch(new Request("https://vault.internal/internal/status"))
      const migration = state.storage.sql
        .exec<{ version: number }>("SELECT MAX(id) AS version FROM _sql_schema_migrations")
        .one()
      expect(migration.version).toBe(1)
      const tables = state.storage.sql
        .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .toArray()
        .map((row) => row.name)
      expect(tables).toContain("operations")
      expect(tables).toContain("devices")
      expect(tables).toContain("snapshots")
    })
  })

  it("adopts pre-ledger v1 tables without recreating them", async () => {
    const id = env.VAULT.idFromName("legacy-schema-test")
    const stub = env.VAULT.get(id)
    await runInDurableObject(stub, async (instance, state) => {
      await instance.fetch(new Request("https://vault.internal/internal/status"))
      state.storage.sql.exec("DELETE FROM _sql_schema_migrations")

      migrateVaultSchema(state.storage.sql, (callback) => state.storage.transactionSync(callback))

      const migration = state.storage.sql
        .exec<{ version: number }>("SELECT MAX(id) AS version FROM _sql_schema_migrations")
        .one()
      expect(migration.version).toBe(1)
      expect(
        state.storage.sql
          .exec<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'operations'",
          )
          .one().name,
      ).toBe("operations")
    })
  })

  it("claims once, authenticates, appends idempotently, and proxies private blobs", async () => {
    const { deviceId, sessionToken, signingKey, vaultId } = await setupAndAuthenticate()
    const authorization = { authorization: `Bearer ${sessionToken}` }

    const unsignedOperation: Operation = {
      operationId: randomToken(18),
      authorDeviceId: deviceId,
      epochId: randomToken(18),
      type: "revision",
      envelope: base64UrlEncode(randomBytes(128)),
      signature: base64UrlEncode(randomBytes(64)),
    }
    const operation: Operation = {
      ...unsignedOperation,
      signature: await sign(signingKey, operationSigningMessage(unsignedOperation)),
    }
    const firstCommit = await SELF.fetch("https://example.test/v1/operations", {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify(operation),
    })
    expect(firstCommit.status).toBe(201)
    await expect(firstCommit.json()).resolves.toMatchObject({ cursor: 1, duplicate: false })

    const duplicateCommit = await SELF.fetch("https://example.test/v1/operations", {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify(operation),
    })
    expect(duplicateCommit.status).toBe(200)
    await expect(duplicateCommit.json()).resolves.toMatchObject({ cursor: 1, duplicate: true })

    const changes = await SELF.fetch(
      `https://example.test/v1/changes?after=0&afterHash=${encodeURIComponent(ZERO_HASH)}`,
      { headers: authorization },
    )
    expect(changes.status).toBe(200)
    await expect(changes.json()).resolves.toMatchObject({ latestCursor: 1, hasMore: false })

    const blobId = randomToken(18)
    const blob = randomBytes(1024)
    const upload = await SELF.fetch(`https://example.test/v1/blobs/${blobId}`, {
      method: "PUT",
      headers: { ...authorization, "content-type": "application/octet-stream" },
      body: blob,
    })
    expect(upload.status).toBe(201)

    const secondUpload = await SELF.fetch(`https://example.test/v1/blobs/${blobId}`, {
      method: "PUT",
      headers: { ...authorization, "content-type": "application/octet-stream" },
      body: blob,
    })
    expect(secondUpload.status).toBe(204)

    const download = await SELF.fetch(`https://example.test/v1/blobs/${blobId}`, {
      headers: authorization,
    })
    expect(download.status).toBe(200)
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(blob)

    const pairingResponse = await SELF.fetch("https://example.test/v1/pairings", {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify({ expiresInSeconds: 300 }),
    })
    expect(pairingResponse.status).toBe(201)
    const pairing = (await pairingResponse.json()) as {
      pairingId: string
      capability: string
    }
    const candidateKey = await createSigningKey()
    const candidateId = randomToken(18)
    const candidate = {
      deviceId: candidateId,
      signingPublicKey: await publicKey(candidateKey),
      hpkePublicKey: base64UrlEncode(randomBytes(32)),
    }
    const unsignedJoin: PairingJoin = {
      capability: pairing.capability,
      device: candidate,
      proof: base64UrlEncode(randomBytes(64)),
    }
    const join: PairingJoin = {
      ...unsignedJoin,
      proof: await sign(
        candidateKey,
        pairingJoinSigningMessage(vaultId, pairing.pairingId, unsignedJoin),
      ),
    }
    const joinResponse = await SELF.fetch(
      `https://example.test/v1/pairings/${pairing.pairingId}/join`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(join),
      },
    )
    expect(joinResponse.status).toBe(200)

    const unsignedApproval: PairingApproval = {
      certificate: base64UrlEncode(randomBytes(96)),
      transcriptHash: base64UrlEncode(randomBytes(32)),
      approvalSignature: base64UrlEncode(randomBytes(64)),
      hpkeTransfer: base64UrlEncode(randomBytes(128)),
    }
    const approval: PairingApproval = {
      ...unsignedApproval,
      approvalSignature: await sign(
        signingKey,
        pairingApprovalSigningMessage(
          vaultId,
          pairing.pairingId,
          {
            device_id: candidate.deviceId,
            signing_public_key: candidate.signingPublicKey,
            hpke_public_key: candidate.hpkePublicKey,
          },
          unsignedApproval,
        ),
      ),
    }
    const approvalResponse = await SELF.fetch(
      `https://example.test/v1/pairings/${pairing.pairingId}/approve`,
      {
        method: "POST",
        headers: { ...authorization, "content-type": "application/json" },
        body: JSON.stringify(approval),
      },
    )
    expect(approvalResponse.status).toBe(200)

    const resultResponse = await SELF.fetch(
      `https://example.test/v1/pairings/${pairing.pairingId}/result`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ capability: pairing.capability }),
      },
    )
    expect(resultResponse.status).toBe(200)
    await expect(resultResponse.json()).resolves.toMatchObject({
      status: "approved",
      deviceId: candidateId,
    })
    const consumedResult = await SELF.fetch(
      `https://example.test/v1/pairings/${pairing.pairingId}/result`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ capability: pairing.capability }),
      },
    )
    expect(consumedResult.status).toBe(410)

    const candidateSession = await authenticateDevice(vaultId, candidateId, candidateKey)
    const unsignedRevocation: Operation = {
      operationId: randomToken(18),
      authorDeviceId: deviceId,
      epochId: randomToken(18),
      type: "device-revocation",
      subjectDeviceId: candidateId,
      envelope: base64UrlEncode(randomBytes(128)),
      signature: base64UrlEncode(randomBytes(64)),
    }
    const revocation: Operation = {
      ...unsignedRevocation,
      signature: await sign(signingKey, operationSigningMessage(unsignedRevocation)),
    }
    const revokeResponse = await SELF.fetch(
      `https://example.test/v1/devices/${candidateId}/revoke`,
      {
        method: "POST",
        headers: { ...authorization, "content-type": "application/json" },
        body: JSON.stringify({ operation: revocation }),
      },
    )
    expect(revokeResponse.status).toBe(201)
    const revokedSessionResponse = await SELF.fetch("https://example.test/v1/devices", {
      headers: { authorization: `Bearer ${candidateSession}` },
    })
    expect(revokedSessionResponse.status).toBe(401)

    const secondSetup = await SELF.fetch("https://example.test/v1/setup/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: SETUP_TOKEN }),
    })
    expect(secondSetup.status).toBe(409)
  })
})
