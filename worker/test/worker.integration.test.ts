import { env, runInDurableObject, SELF } from "cloudflare:test"
import {
  createFirstDeviceClaimBundle,
  serializeEncryptedRecoveryPackage,
  sign as signBytes,
} from "@meridian/crypto"
import {
  type Ed25519PrivateKey,
  encodeDeviceCertificate,
  pairingCandidateConfirmationSigningBytes,
  pairingCompletionSigningBytes,
} from "@meridian/protocol"
import { describe, expect, it } from "vitest"
import { base64UrlDecode, base64UrlEncode, randomToken, sha256, ZERO_HASH } from "../src/encoding"
import type {
  Checkpoint,
  Operation,
  PairingApproval,
  PairingJoin,
  PairingRelease,
  SetupClaim,
} from "../src/schemas"
import { migrateVaultSchema } from "../src/vault/migrations"
import {
  authSigningMessage,
  checkpointSigningMessage,
  operationSigningMessage,
  pairingApprovalSigningMessage,
  pairingJoinSigningMessage,
  setupClaimSigningMessage,
} from "../src/vault-do"

const SETUP_TOKEN = "integration-test-setup-token-32-bytes-long"

function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return bytes
}

function nonCanonicalAlias(value: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
  const last = alphabet.indexOf(value.at(-1) ?? "")
  if (last < 0 || last % 16 !== 0) throw new Error("Expected a 16-byte canonical identifier")
  return `${value.slice(0, -1)}${alphabet[last + 1]}`
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
  const repeatedChallengeResponse = await SELF.fetch("https://example.test/v1/auth/challenge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceId }),
  })
  expect(repeatedChallengeResponse.status).toBe(200)
  await expect(repeatedChallengeResponse.json()).resolves.toMatchObject(challenge)

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
      expect(migration.version).toBe(3)
      const tables = state.storage.sql
        .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .toArray()
        .map((row) => row.name)
      expect(tables).toContain("operations")
      expect(tables).toContain("devices")
      expect(tables).toContain("snapshots")
      const pairingsDefinition = state.storage.sql
        .exec<{ sql: string }>(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'pairings'",
        )
        .one().sql
      expect(pairingsDefinition).toContain("candidate_request_proof")
      expect(pairingsDefinition).toContain("verification_preview")
      expect(pairingsDefinition).toContain("'completed'")
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
      expect(migration.version).toBe(3)
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
    const descriptorResponse = await SELF.fetch("https://example.test/v1/device/descriptor", {
      method: "PUT",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify({ deviceName: "Test Mac", platform: "macOS" }),
    })
    expect(descriptorResponse.status).toBe(200)
    await expect(descriptorResponse.json()).resolves.toMatchObject({
      deviceId,
      deviceName: "Test Mac",
      platform: "macOS",
    })

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
    const firstCommitResult = (await firstCommit.json()) as {
      cursor: number
      chainHash: string
      duplicate: boolean
    }
    expect(firstCommitResult).toMatchObject({ cursor: 1, duplicate: false })

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

    const unsignedCheckpoint: Checkpoint = {
      checkpointId: randomToken(18),
      cursor: firstCommitResult.cursor,
      logHash: firstCommitResult.chainHash,
      epochId: randomToken(18),
      envelope: base64UrlEncode(randomBytes(128)),
      signature: base64UrlEncode(randomBytes(64)),
    }
    const checkpoint: Checkpoint = {
      ...unsignedCheckpoint,
      signature: await sign(signingKey, checkpointSigningMessage(unsignedCheckpoint)),
    }
    const firstCheckpoint = await SELF.fetch("https://example.test/v1/checkpoints", {
      method: "PUT",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify(checkpoint),
    })
    expect(firstCheckpoint.status).toBe(201)

    const duplicateCheckpoint = await SELF.fetch("https://example.test/v1/checkpoints", {
      method: "PUT",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify(checkpoint),
    })
    expect(duplicateCheckpoint.status).toBe(200)
    await expect(duplicateCheckpoint.json()).resolves.toMatchObject({ duplicate: true })

    const conflictingUnsignedCheckpoint = { ...checkpoint, epochId: randomToken(18) }
    const conflictingCheckpoint = {
      ...conflictingUnsignedCheckpoint,
      signature: await sign(signingKey, checkpointSigningMessage(conflictingUnsignedCheckpoint)),
    }
    const conflictingCheckpointResponse = await SELF.fetch("https://example.test/v1/checkpoints", {
      method: "PUT",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify(conflictingCheckpoint),
    })
    expect(conflictingCheckpointResponse.status).toBe(409)
    await expect(conflictingCheckpointResponse.json()).resolves.toMatchObject({
      error: { code: "idempotency_conflict" },
    })

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

    const concurrentBlobId = randomToken(18)
    const concurrentBlob = randomBytes(1024)
    const concurrentUploads = await Promise.all(
      [0, 1].map(() =>
        SELF.fetch(`https://example.test/v1/blobs/${concurrentBlobId}`, {
          method: "PUT",
          headers: { ...authorization, "content-type": "application/octet-stream" },
          body: concurrentBlob,
        }),
      ),
    )
    expect(concurrentUploads.map((response) => response.status).sort()).toEqual([201, 204])
    const concurrentDownload = await SELF.fetch(
      `https://example.test/v1/blobs/${concurrentBlobId}`,
      { headers: authorization },
    )
    expect(concurrentDownload.status).toBe(200)
    expect(new Uint8Array(await concurrentDownload.arrayBuffer())).toEqual(concurrentBlob)

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
    expect(base64UrlDecode(pairing.pairingId).byteLength).toBe(16)
    const candidateKey = await createSigningKey()
    const candidateId = randomToken(16)
    const candidate = {
      deviceId: candidateId,
      signingPublicKey: await publicKey(candidateKey),
      hpkePublicKey: base64UrlEncode(randomBytes(32)),
      deviceName: "Test iPhone",
      platform: "iOS",
    }
    const pendingStatus = await SELF.fetch(
      `https://example.test/v1/pairings/${pairing.pairingId}`,
      { headers: authorization },
    )
    expect(pendingStatus.status).toBe(200)
    await expect(pendingStatus.json()).resolves.toMatchObject({
      pairingId: pairing.pairingId,
      status: "pending",
      relayAvailable: false,
    })
    const pendingProgress = await SELF.fetch(
      `https://example.test/v1/pairings/${pairing.pairingId}/status`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ capability: pairing.capability }),
      },
    )
    expect(pendingProgress.status).toBe(200)
    await expect(pendingProgress.json()).resolves.toMatchObject({ status: "pending" })

    const requestProof = base64UrlEncode(randomBytes(64))
    const unsignedJoin: PairingJoin = {
      capability: pairing.capability,
      device: candidate,
      proof: base64UrlEncode(randomBytes(64)),
      requestProof,
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
    const repeatedJoinResponse = await SELF.fetch(
      `https://example.test/v1/pairings/${pairing.pairingId}/join`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(join),
      },
    )
    expect(repeatedJoinResponse.status).toBe(200)
    await expect(repeatedJoinResponse.json()).resolves.toMatchObject({ status: "joined" })

    const joinedStatus = await SELF.fetch(`https://example.test/v1/pairings/${pairing.pairingId}`, {
      headers: authorization,
    })
    expect(joinedStatus.status).toBe(200)
    await expect(joinedStatus.json()).resolves.toMatchObject({
      status: "joined",
      relayAvailable: true,
      candidate: {
        pairingId: pairing.pairingId,
        vaultId,
        deviceId: candidateId,
        requestProof,
      },
    })
    const unauthenticatedStatus = await SELF.fetch(
      `https://example.test/v1/pairings/${pairing.pairingId}`,
    )
    expect(unauthenticatedStatus.status).toBe(401)

    const transferBytes = randomBytes(128)
    const transferHash = base64UrlEncode(await sha256(transferBytes))
    const approval: PairingApproval = {
      certificate: base64UrlEncode(randomBytes(96)),
      transcriptHash: transferHash,
      verificationPreview: base64UrlEncode(randomBytes(128)),
    }
    const unsignedRelease: PairingRelease = {
      approvalSignature: base64UrlEncode(randomBytes(64)),
      hpkeTransfer: base64UrlEncode(transferBytes),
    }
    const release: PairingRelease = {
      ...unsignedRelease,
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
          { ...approval, ...unsignedRelease },
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
    const repeatedApprovalResponse = await SELF.fetch(
      `https://example.test/v1/pairings/${pairing.pairingId}/approve`,
      {
        method: "POST",
        headers: { ...authorization, "content-type": "application/json" },
        body: JSON.stringify(approval),
      },
    )
    expect(repeatedApprovalResponse.status).toBe(200)
    await expect(repeatedApprovalResponse.json()).resolves.toMatchObject({ status: "verifying" })

    const verificationResult = await SELF.fetch(
      `https://example.test/v1/pairings/${pairing.pairingId}/result`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ capability: pairing.capability }),
      },
    )
    expect(verificationResult.status).toBe(200)
    const verificationBody = (await verificationResult.json()) as Record<string, unknown>
    expect(verificationBody).toMatchObject({
      status: "verifying",
      transcriptHash: transferHash,
      verificationPreview: approval.verificationPreview,
    })
    expect(verificationBody).not.toHaveProperty("hpkeTransfer")

    const earlyAuth = await SELF.fetch("https://example.test/v1/auth/challenge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceId: candidateId }),
    })
    expect(earlyAuth.status).toBe(404)

    const candidateConfirmation = {
      capability: pairing.capability,
      transferHash,
      proof: await sign(
        candidateKey,
        pairingCandidateConfirmationSigningBytes({
          vaultId,
          pairingId: pairing.pairingId,
          candidateDeviceId: candidateId,
          transferHash,
        }),
      ),
    }
    const candidateConfirmationResponse = await SELF.fetch(
      `https://example.test/v1/pairings/${pairing.pairingId}/confirm-candidate`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(candidateConfirmation),
      },
    )
    expect(candidateConfirmationResponse.status).toBe(200)
    await expect(candidateConfirmationResponse.json()).resolves.toMatchObject({
      status: "verifying",
    })

    const ownerConfirmationResponse = await SELF.fetch(
      `https://example.test/v1/pairings/${pairing.pairingId}/confirm-owner`,
      {
        method: "POST",
        headers: { ...authorization, "content-type": "application/json" },
        body: "{}",
      },
    )
    expect(ownerConfirmationResponse.status).toBe(200)
    await expect(ownerConfirmationResponse.json()).resolves.toMatchObject({ status: "confirmed" })

    const confirmedStatus = await SELF.fetch(
      `https://example.test/v1/pairings/${pairing.pairingId}`,
      { headers: authorization },
    )
    await expect(confirmedStatus.json()).resolves.toMatchObject({
      status: "confirmed",
      candidateConfirmation: {
        transferHash,
        proof: candidateConfirmation.proof,
      },
    })
    const withheldResult = await SELF.fetch(
      `https://example.test/v1/pairings/${pairing.pairingId}/result`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ capability: pairing.capability }),
      },
    )
    const withheldBody = (await withheldResult.json()) as Record<string, unknown>
    expect(withheldBody).toMatchObject({ status: "confirmed" })
    expect(withheldBody).not.toHaveProperty("hpkeTransfer")

    const releaseResponse = await SELF.fetch(
      `https://example.test/v1/pairings/${pairing.pairingId}/release`,
      {
        method: "POST",
        headers: { ...authorization, "content-type": "application/json" },
        body: JSON.stringify(release),
      },
    )
    expect(releaseResponse.status).toBe(200)
    await expect(releaseResponse.json()).resolves.toMatchObject({ status: "released" })

    const releaseReplay = await SELF.fetch(
      `https://example.test/v1/pairings/${pairing.pairingId}/release`,
      {
        method: "POST",
        headers: { ...authorization, "content-type": "application/json" },
        body: JSON.stringify(release),
      },
    )
    expect(releaseReplay.status).toBe(200)

    const conflictingRelease = await SELF.fetch(
      `https://example.test/v1/pairings/${pairing.pairingId}/release`,
      {
        method: "POST",
        headers: { ...authorization, "content-type": "application/json" },
        body: JSON.stringify({ ...release, hpkeTransfer: base64UrlEncode(randomBytes(32)) }),
      },
    )
    expect(conflictingRelease.status).toBe(409)
    await expect(conflictingRelease.json()).resolves.toMatchObject({
      error: { code: "idempotency_conflict" },
    })

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const releasedResult = await SELF.fetch(
        `https://example.test/v1/pairings/${pairing.pairingId}/result`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ capability: pairing.capability }),
        },
      )
      expect(releasedResult.status).toBe(200)
      await expect(releasedResult.json()).resolves.toMatchObject({
        status: "released",
        deviceId: candidateId,
        hpkeTransfer: release.hpkeTransfer,
      })
    }

    const completion = {
      capability: pairing.capability,
      transferHash,
      proof: await sign(
        candidateKey,
        pairingCompletionSigningBytes({
          vaultId,
          pairingId: pairing.pairingId,
          candidateDeviceId: candidateId,
          transferHash,
        }),
      ),
    }
    const completionResponse = await SELF.fetch(
      `https://example.test/v1/pairings/${pairing.pairingId}/complete`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(completion),
      },
    )
    expect(completionResponse.status).toBe(200)
    await expect(completionResponse.json()).resolves.toMatchObject({ status: "completed" })
    const completedResult = await SELF.fetch(
      `https://example.test/v1/pairings/${pairing.pairingId}/result`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ capability: pairing.capability }),
      },
    )
    await expect(completedResult.json()).resolves.toMatchObject({
      status: "completed",
      hpkeTransfer: release.hpkeTransfer,
    })

    const pairingStub = env.VAULT.get(env.VAULT.idFromName("primary"))
    await runInDurableObject(pairingStub, async (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE pairings SET expires_at = ? WHERE pairing_id = ?",
        Date.now() - 1,
        pairing.pairingId,
      )
    })
    const completedRetry = await SELF.fetch(
      `https://example.test/v1/pairings/${pairing.pairingId}/complete`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(completion),
      },
    )
    expect(completedRetry.status).toBe(200)
    await expect(completedRetry.json()).resolves.toMatchObject({ status: "completed" })

    const conflictingCompletion = await SELF.fetch(
      `https://example.test/v1/pairings/${pairing.pairingId}/complete`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...completion, proof: base64UrlEncode(randomBytes(64)) }),
      },
    )
    expect(conflictingCompletion.status).toBe(409)
    await expect(conflictingCompletion.json()).resolves.toMatchObject({
      error: { code: "idempotency_conflict" },
    })

    const expiredCompletedResult = await SELF.fetch(
      `https://example.test/v1/pairings/${pairing.pairingId}/result`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ capability: pairing.capability }),
      },
    )
    expect(expiredCompletedResult.status).toBe(200)
    await expect(expiredCompletedResult.json()).resolves.toMatchObject({ status: "completed" })

    const devicesAfterPairing = await SELF.fetch("https://example.test/v1/devices", {
      headers: authorization,
    })
    await expect(devicesAfterPairing.json()).resolves.toMatchObject({
      devices: expect.arrayContaining([
        expect.objectContaining({
          deviceId: candidateId,
          deviceName: "Test iPhone",
          platform: "iOS",
        }),
      ]),
    })

    const candidateSession = await authenticateDevice(vaultId, candidateId, candidateKey)

    const canceledPairingResponse = await SELF.fetch("https://example.test/v1/pairings", {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify({ expiresInSeconds: 300 }),
    })
    const canceledPairing = (await canceledPairingResponse.json()) as {
      pairingId: string
      capability: string
    }
    const canceledCandidateKey = await createSigningKey()
    const canceledCandidate = {
      deviceId: randomToken(16),
      signingPublicKey: await publicKey(canceledCandidateKey),
      hpkePublicKey: base64UrlEncode(randomBytes(32)),
      deviceName: "Canceled phone",
      platform: "iOS",
    }
    const canceledUnsignedJoin: PairingJoin = {
      capability: canceledPairing.capability,
      device: canceledCandidate,
      proof: base64UrlEncode(randomBytes(64)),
      requestProof: base64UrlEncode(randomBytes(64)),
    }
    const canceledJoin: PairingJoin = {
      ...canceledUnsignedJoin,
      proof: await sign(
        canceledCandidateKey,
        pairingJoinSigningMessage(vaultId, canceledPairing.pairingId, canceledUnsignedJoin),
      ),
    }
    const canceledJoinResponse = await SELF.fetch(
      `https://example.test/v1/pairings/${canceledPairing.pairingId}/join`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(canceledJoin),
      },
    )
    expect(canceledJoinResponse.status).toBe(200)
    const cancelResponse = await SELF.fetch(
      `https://example.test/v1/pairings/${canceledPairing.pairingId}/cancel`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ capability: canceledPairing.capability }),
      },
    )
    expect(cancelResponse.status).toBe(200)
    await expect(cancelResponse.json()).resolves.toMatchObject({ status: "canceled" })
    const canceledAuth = await SELF.fetch("https://example.test/v1/auth/challenge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceId: canceledCandidate.deviceId }),
    })
    expect(canceledAuth.status).toBe(404)

    const ownerRevocationTarget = randomToken(16)
    const primaryStub = env.VAULT.get(env.VAULT.idFromName("primary"))
    await runInDurableObject(primaryStub, async (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO devices(
          device_id, signing_public_key, hpke_public_key, certificate, role, authorized_at,
          authorized_by, device_name, platform
        ) VALUES (?, ?, ?, ?, 'member', ?, ?, ?, ?)`,
        ownerRevocationTarget,
        base64UrlEncode(randomBytes(32)),
        base64UrlEncode(randomBytes(32)),
        base64UrlEncode(randomBytes(96)),
        Date.now(),
        deviceId,
        "Retired phone",
        "iOS",
      )
    })
    const ownerRevocationUnsigned: Operation = {
      operationId: randomToken(18),
      authorDeviceId: deviceId,
      epochId: randomToken(18),
      type: "device-revocation",
      subjectDeviceId: ownerRevocationTarget,
      envelope: base64UrlEncode(randomBytes(128)),
      signature: base64UrlEncode(randomBytes(64)),
    }
    const ownerRevocation: Operation = {
      ...ownerRevocationUnsigned,
      signature: await sign(signingKey, operationSigningMessage(ownerRevocationUnsigned)),
    }
    for (const expectedStatus of [201, 200]) {
      const response = await SELF.fetch(
        `https://example.test/v1/devices/${ownerRevocationTarget}/revoke`,
        {
          method: "POST",
          headers: { ...authorization, "content-type": "application/json" },
          body: JSON.stringify({ operation: ownerRevocation }),
        },
      )
      expect(response.status).toBe(expectedStatus)
      if (expectedStatus === 200) {
        await expect(response.json()).resolves.toMatchObject({ duplicate: true })
      }
    }

    const memberCrossRevocationUnsigned: Operation = {
      operationId: randomToken(18),
      authorDeviceId: candidateId,
      epochId: randomToken(18),
      type: "device-revocation",
      subjectDeviceId: deviceId,
      envelope: base64UrlEncode(randomBytes(128)),
      signature: base64UrlEncode(randomBytes(64)),
    }
    const memberCrossRevocation: Operation = {
      ...memberCrossRevocationUnsigned,
      signature: await sign(candidateKey, operationSigningMessage(memberCrossRevocationUnsigned)),
    }
    const memberCrossResponse = await SELF.fetch(
      `https://example.test/v1/devices/${deviceId}/revoke`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${candidateSession}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ operation: memberCrossRevocation }),
      },
    )
    expect(memberCrossResponse.status).toBe(403)
    await expect(memberCrossResponse.json()).resolves.toMatchObject({
      error: { code: "owner_required" },
    })

    const ownerSelfRevocationUnsigned: Operation = {
      operationId: randomToken(18),
      authorDeviceId: deviceId,
      epochId: randomToken(18),
      type: "device-revocation",
      subjectDeviceId: deviceId,
      envelope: base64UrlEncode(randomBytes(128)),
      signature: base64UrlEncode(randomBytes(64)),
    }
    const ownerSelfRevocation: Operation = {
      ...ownerSelfRevocationUnsigned,
      signature: await sign(signingKey, operationSigningMessage(ownerSelfRevocationUnsigned)),
    }
    const ownerSelfResponse = await SELF.fetch(
      `https://example.test/v1/devices/${deviceId}/revoke`,
      {
        method: "POST",
        headers: { ...authorization, "content-type": "application/json" },
        body: JSON.stringify({ operation: ownerSelfRevocation }),
      },
    )
    expect(ownerSelfResponse.status).toBe(409)
    await expect(ownerSelfResponse.json()).resolves.toMatchObject({
      error: { code: "cannot_revoke_owner" },
    })

    const selfRevocationUnsigned: Operation = {
      operationId: randomToken(18),
      authorDeviceId: candidateId,
      epochId: randomToken(18),
      type: "device-revocation",
      subjectDeviceId: candidateId,
      envelope: base64UrlEncode(randomBytes(128)),
      signature: base64UrlEncode(randomBytes(64)),
    }
    const selfRevocation: Operation = {
      ...selfRevocationUnsigned,
      signature: await sign(candidateKey, operationSigningMessage(selfRevocationUnsigned)),
    }
    const selfRevokeResponse = await SELF.fetch(
      `https://example.test/v1/devices/${candidateId}/revoke`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${candidateSession}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ operation: selfRevocation }),
      },
    )
    expect(selfRevokeResponse.status).toBe(201)
    const revokedSessionResponse = await SELF.fetch("https://example.test/v1/devices", {
      headers: { authorization: `Bearer ${candidateSession}` },
    })
    expect(revokedSessionResponse.status).toBe(401)

    const reusedIdentityPairingResponse = await SELF.fetch("https://example.test/v1/pairings", {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify({ expiresInSeconds: 300 }),
    })
    expect(reusedIdentityPairingResponse.status).toBe(201)
    const reusedIdentityPairing = (await reusedIdentityPairingResponse.json()) as {
      pairingId: string
      capability: string
    }
    const unsignedReusedIdentityJoin: PairingJoin = {
      capability: reusedIdentityPairing.capability,
      device: candidate,
      proof: base64UrlEncode(randomBytes(64)),
      requestProof: base64UrlEncode(randomBytes(64)),
    }
    const reusedIdentityJoin = {
      ...unsignedReusedIdentityJoin,
      proof: await sign(
        candidateKey,
        pairingJoinSigningMessage(
          vaultId,
          reusedIdentityPairing.pairingId,
          unsignedReusedIdentityJoin,
        ),
      ),
    }
    const reusedIdentityJoinResponse = await SELF.fetch(
      `https://example.test/v1/pairings/${reusedIdentityPairing.pairingId}/join`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(reusedIdentityJoin),
      },
    )
    expect(reusedIdentityJoinResponse.status).toBe(409)
    await expect(reusedIdentityJoinResponse.json()).resolves.toMatchObject({
      error: { code: "device_exists" },
    })

    const aliasedCandidate = { ...candidate, deviceId: nonCanonicalAlias(candidate.deviceId) }
    const unsignedAliasedJoin: PairingJoin = {
      ...unsignedReusedIdentityJoin,
      device: aliasedCandidate,
    }
    const aliasedJoin = {
      ...unsignedAliasedJoin,
      proof: await sign(
        candidateKey,
        pairingJoinSigningMessage(vaultId, reusedIdentityPairing.pairingId, unsignedAliasedJoin),
      ),
    }
    const aliasedJoinResponse = await SELF.fetch(
      `https://example.test/v1/pairings/${reusedIdentityPairing.pairingId}/join`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(aliasedJoin),
      },
    )
    expect(aliasedJoinResponse.status).toBe(400)
    await expect(aliasedJoinResponse.json()).resolves.toMatchObject({
      error: { code: "invalid_identifier" },
    })

    const secondSetup = await SELF.fetch("https://example.test/v1/setup/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: SETUP_TOKEN }),
    })
    expect(secondSetup.status).toBe(409)
  })
})
