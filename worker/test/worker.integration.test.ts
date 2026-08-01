import { env, runInDurableObject, SELF } from "cloudflare:test"
import {
  createFirstDeviceClaimBundle,
  type DeviceKeyBundle,
  prepareEpochTransition,
  serializeEncryptedRecoveryPackage,
  sign as signBytes,
  signOperation,
} from "@meridian/crypto"
import {
  CIPHER_SUITE,
  certificateId,
  epochId as deviceEpochId,
  type Ed25519PrivateKey,
  type Ed25519PublicKey,
  ed25519Signature,
  encodeDeviceCertificate,
  encodeOperation,
  fileId,
  hashBytes,
  LogFormat,
  logChainSigningBytes,
  logEntryHashInput,
  nonce,
  operationId,
  operationSigningBytes,
  pairingCandidateConfirmationSigningBytes,
  pairingCompletionSigningBytes,
  blobId as protocolBlobId,
  deviceId as protocolDeviceId,
  vaultId as protocolVaultId,
  revisionId,
  wrappedRevisionKey,
} from "@meridian/protocol"
import { describe, expect, it } from "vitest"
import { base64UrlDecode, base64UrlEncode, randomToken, sha256, ZERO_HASH } from "../src/encoding"
import type {
  Checkpoint,
  Operation,
  PairingApproval,
  PairingJoin,
  PairingRelease,
  RetentionAcknowledgement,
  SetupClaim,
} from "../src/schemas"
import { migrateVaultSchema } from "../src/vault/migrations"
import {
  authSigningMessage,
  checkpointSigningMessage,
  operationSigningMessage,
  pairingApprovalSigningMessage,
  pairingJoinSigningMessage,
  retentionAcknowledgementSigningMessage,
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

async function signedRevocation(
  key: CryptoKeyPair | Ed25519PrivateKey,
  vault: string,
  authorDeviceId: string,
  epoch: string,
  subjectDeviceId: string,
): Promise<Operation> {
  const identifier = operationId(randomBytes(16))
  const body = {
    type: "device-revocation" as const,
    operationId: identifier,
    vaultId: protocolVaultId(base64UrlDecode(vault, 16)),
    epochId: deviceEpochId(base64UrlDecode(epoch, 16)),
    authorDeviceId: protocolDeviceId(base64UrlDecode(authorDeviceId, 16)),
    certificateId: certificateId(randomBytes(16)),
    reason: "retired" as const,
    suite: CIPHER_SUITE,
  }
  const signed = {
    body,
    signature: ed25519Signature(base64UrlDecode(await sign(key, operationSigningBytes(body)), 64)),
  }
  const unsigned: Operation = {
    operationId: base64UrlEncode(identifier),
    authorDeviceId,
    epochId: epoch,
    type: "device-revocation",
    subjectDeviceId,
    envelope: base64UrlEncode(encodeOperation(signed)),
    signature: base64UrlEncode(randomBytes(64)),
  }
  return { ...unsigned, signature: await sign(key, operationSigningMessage(unsigned)) }
}

type TestFetch = (url: string, init?: RequestInit) => Promise<Response>

const publicFetch: TestFetch = (url, init) => SELF.fetch(url, init)

async function authenticateDevice(
  vaultId: string,
  deviceId: string,
  signingKey: CryptoKeyPair | Ed25519PrivateKey,
  fetcher: TestFetch = publicFetch,
): Promise<string> {
  const challengeResponse = await fetcher("https://example.test/v1/auth/challenge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceId }),
  })
  expect(challengeResponse.status).toBe(200)
  const challenge = (await challengeResponse.json()) as {
    challengeId: string
    challenge: string
  }
  const repeatedChallengeResponse = await fetcher("https://example.test/v1/auth/challenge", {
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
    supportedLogFormats: ["legacy-http-v1", "canonical-cbor-v1"],
    supportedFeatures: ["epoch-transition-v1"],
  }
  authInput.signature = await sign(
    signingKey,
    authSigningMessage(vaultId, authInput, challenge.challenge),
  )
  const sessionResponse = await fetcher("https://example.test/v1/auth/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(authInput),
  })
  expect(sessionResponse.status).toBe(200)
  const session = (await sessionResponse.json()) as { sessionToken: string }
  return session.sessionToken
}

async function setupAndAuthenticate(
  fetcher: TestFetch = publicFetch,
  setupPath = "/v1/setup/session",
): Promise<{
  readonly deviceId: string
  readonly sessionToken: string
  readonly signingKey: Ed25519PrivateKey
  readonly vaultId: string
  readonly device: DeviceKeyBundle
  readonly recoveryPublicKey: Ed25519PublicKey
}> {
  const first = await createFirstDeviceClaimBundle()
  const signingKey = first.device.signingPrivateKey
  const deviceId = base64UrlEncode(first.device.deviceId)
  const vaultId = base64UrlEncode(first.device.vaultId)
  const signingPublicKey = base64UrlEncode(first.device.signingPublicKey)

  const setupResponse = await fetcher(`https://example.test${setupPath}`, {
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
    logFormat: "canonical-cbor-v1",
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
  const claimResponse = await fetcher("https://example.test/v1/setup/claim", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(claim),
  })
  expect(claimResponse.status).toBe(201)

  const sessionToken = await authenticateDevice(vaultId, deviceId, signingKey, fetcher)
  return {
    deviceId,
    sessionToken,
    signingKey,
    vaultId,
    device: first.device,
    recoveryPublicKey: first.recoveryPublicKey,
  }
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
      expect(migration.version).toBe(10)
      const tables = state.storage.sql
        .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .toArray()
        .map((row) => row.name)
      expect(tables).toContain("operations")
      expect(tables).toContain("devices")
      expect(tables).toContain("snapshots")
      expect(tables).toContain("blob_claims")
      expect(tables).toContain("retention_acknowledgements")
      expect(tables).toContain("blob_catalog")
      const pairingsDefinition = state.storage.sql
        .exec<{ sql: string }>(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'pairings'",
        )
        .one().sql
      expect(pairingsDefinition).toContain("candidate_request_proof")
      expect(pairingsDefinition).toContain("verification_preview")
      expect(pairingsDefinition).toContain("'completed'")
      const devicesDefinition = state.storage.sql
        .exec<{ sql: string }>(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'devices'",
        )
        .one().sql
      expect(devicesDefinition).toContain("supports_canonical_log")
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
      expect(migration.version).toBe(10)
      expect(
        state.storage.sql
          .exec<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'operations'",
          )
          .one().name,
      ).toBe("operations")
    })
  })

  it("bridges a migrated legacy log and blocks old sessions", async () => {
    const primaryStub = env.VAULT.get(env.VAULT.idFromName("log-transition-test"))
    const directFetch: TestFetch = (url, init) => primaryStub.fetch(new Request(url, init))
    const { deviceId, signingKey, vaultId, device } = await setupAndAuthenticate(
      directFetch,
      "/internal/setup/session",
    )
    await runInDurableObject(primaryStub, async (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE vault_state SET log_format = 'legacy-http-v1', log_transition_cursor = NULL",
      )
      state.storage.sql.exec("UPDATE devices SET supports_canonical_log = 0")
    })
    const sessionToken = await authenticateDevice(vaultId, deviceId, signingKey, directFetch)
    const authorization = { authorization: `Bearer ${sessionToken}` }
    const registryResponse = await directFetch("https://example.test/v1/devices", {
      headers: authorization,
    })
    expect(registryResponse.status).toBe(200)
    expect(await registryResponse.json()).toMatchObject({
      devices: [{ deviceId, supportsCanonicalLog: true }],
    })

    const transitionIdentifier = operationId(randomBytes(16))
    const signedTransition = signOperation(
      {
        type: "log-format-transition",
        operationId: transitionIdentifier,
        vaultId: device.vaultId,
        epochId: device.epoch.body.epochId,
        authorDeviceId: device.deviceId,
        previousCursor: 0,
        previousLogHash: hashBytes(new Uint8Array(32)),
        nextLogFormat: LogFormat.CanonicalCborV1,
        suite: CIPHER_SUITE,
      },
      device.signingPrivateKey,
    )
    const transitionUnsigned: Operation = {
      operationId: base64UrlEncode(transitionIdentifier),
      authorDeviceId: deviceId,
      epochId: base64UrlEncode(device.epoch.body.epochId),
      type: "log-format-transition",
      envelope: base64UrlEncode(encodeOperation(signedTransition)),
      signature: base64UrlEncode(randomBytes(64)),
    }
    const transition: Operation = {
      ...transitionUnsigned,
      signature: await sign(signingKey, operationSigningMessage(transitionUnsigned)),
    }
    const transitionResponse = await directFetch("https://example.test/v1/operations", {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify(transition),
    })
    expect(transitionResponse.status).toBe(201)
    const transitionResult = (await transitionResponse.json()) as {
      cursor: number
      chainHash: string
    }
    expect(transitionResult.cursor).toBe(1)
    expect(transitionResult.chainHash).toBe(
      base64UrlEncode(
        await sha256(
          logChainSigningBytes(
            new Uint8Array(32),
            operationSigningMessage(transition),
            base64UrlDecode(transition.signature, 64),
          ),
        ),
      ),
    )
    const duplicate = await directFetch("https://example.test/v1/operations", {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify(transition),
    })
    expect(duplicate.status).toBe(200)

    const revisionIdentifier = operationId(randomBytes(16))
    const signedRevision = signOperation(
      {
        type: "revision",
        operationId: revisionIdentifier,
        vaultId: device.vaultId,
        epochId: device.epoch.body.epochId,
        authorDeviceId: device.deviceId,
        fileId: fileId(randomBytes(16)),
        revisionId: revisionId(randomBytes(16)),
        wrappedRevisionKey: wrappedRevisionKey(randomBytes(40)),
        metadataNonce: nonce(randomBytes(12)),
        encryptedMetadata: randomBytes(16),
        chunks: [],
        suite: CIPHER_SUITE,
      },
      device.signingPrivateKey,
    )
    const revisionUnsigned: Operation = {
      operationId: base64UrlEncode(revisionIdentifier),
      authorDeviceId: deviceId,
      epochId: base64UrlEncode(device.epoch.body.epochId),
      type: "revision",
      envelope: base64UrlEncode(encodeOperation(signedRevision)),
      signature: base64UrlEncode(randomBytes(64)),
    }
    const revision: Operation = {
      ...revisionUnsigned,
      signature: await sign(signingKey, operationSigningMessage(revisionUnsigned)),
    }
    const revisionResponse = await directFetch("https://example.test/v1/operations", {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify(revision),
    })
    expect(revisionResponse.status).toBe(201)
    const revisionResult = (await revisionResponse.json()) as { cursor: number; chainHash: string }
    expect(revisionResult).toEqual({
      cursor: 2,
      chainHash: base64UrlEncode(
        await sha256(
          logEntryHashInput(
            protocolVaultId(base64UrlDecode(vaultId, 16)),
            2,
            hashBytes(base64UrlDecode(transitionResult.chainHash, 32)),
            signedRevision,
          ),
        ),
      ),
      previousHash: transitionResult.chainHash,
      duplicate: false,
    })

    await runInDurableObject(primaryStub, async (_instance, state) => {
      const vault = state.storage.sql
        .exec<{ log_format: string; log_transition_cursor: number }>(
          "SELECT log_format, log_transition_cursor FROM vault_state WHERE singleton = 1",
        )
        .one()
      expect(vault).toEqual({
        log_format: "canonical-cbor-v1",
        log_transition_cursor: 1,
      })
      state.storage.sql.exec("UPDATE sessions SET supports_canonical_log = 0")
    })
    const oldClient = await directFetch("https://example.test/v1/changes?after=2", {
      headers: authorization,
    })
    expect(oldClient.status).toBe(426)
    await expect(oldClient.json()).resolves.toMatchObject({
      error: { code: "protocol_upgrade_required" },
    })
  })

  it("advances epoch and recovery state atomically while rejecting stale writes", async () => {
    const primaryStub = env.VAULT.get(env.VAULT.idFromName("epoch-transition-test"))
    const directFetch: TestFetch = (url, init) => primaryStub.fetch(new Request(url, init))
    const { deviceId, sessionToken, signingKey, device, recoveryPublicKey } =
      await setupAndAuthenticate(directFetch, "/internal/setup/session")
    const authorization = { authorization: `Bearer ${sessionToken}` }
    const recoveryResponse = await directFetch("https://example.test/v1/recovery/package")
    expect(recoveryResponse.status).toBe(200)
    const recovery = (await recoveryResponse.json()) as {
      recoverySigningPublicKey: string
      recoveryStateId: string
    }
    const prepared = await prepareEpochTransition({
      device,
      recipients: [{ deviceId: device.deviceId, hpkePublicKey: device.hpkePublicKey }],
      recoverySigningPublicKey: recoveryPublicKey,
      recoveryStateId: hashBytes(base64UrlDecode(recovery.recoveryStateId, 32)),
      checkpointAuthorizationChain: [device.certificate],
      reason: "migration",
    })
    const concurrentPrepared = await prepareEpochTransition({
      device,
      recipients: [{ deviceId: device.deviceId, hpkePublicKey: device.hpkePublicKey }],
      recoverySigningPublicKey: recoveryPublicKey,
      recoveryStateId: hashBytes(base64UrlDecode(recovery.recoveryStateId, 32)),
      checkpointAuthorizationChain: [device.certificate],
      reason: "migration",
    })
    const epochUnsigned: Operation = {
      operationId: base64UrlEncode(prepared.operation.body.operationId),
      authorDeviceId: deviceId,
      epochId: base64UrlEncode(device.epoch.body.epochId),
      type: "key-epoch",
      envelope: base64UrlEncode(encodeOperation(prepared.operation)),
      signature: base64UrlEncode(randomBytes(64)),
    }
    const epochOperation: Operation = {
      ...epochUnsigned,
      signature: await sign(signingKey, operationSigningMessage(epochUnsigned)),
    }
    await runInDurableObject(primaryStub, async (_instance, state) => {
      state.storage.sql.exec("UPDATE devices SET supports_epoch_transitions = 0")
    })
    const blocked = await directFetch("https://example.test/v1/operations", {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify(epochOperation),
    })
    expect(blocked.status).toBe(409)
    await expect(blocked.json()).resolves.toMatchObject({
      error: { code: "epoch_recipient_conflict" },
    })
    await runInDurableObject(primaryStub, async (_instance, state) => {
      state.storage.sql.exec("UPDATE devices SET supports_epoch_transitions = 1")
    })

    const committed = await directFetch("https://example.test/v1/operations", {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify(epochOperation),
    })
    expect(committed.status).toBe(201)
    const committedBody = (await committed.json()) as { cursor: number }
    expect(committedBody.cursor).toBe(1)

    const duplicate = await directFetch("https://example.test/v1/operations", {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify(epochOperation),
    })
    expect(duplicate.status).toBe(200)
    await expect(duplicate.json()).resolves.toMatchObject({ duplicate: true, cursor: 1 })

    const concurrentUnsigned: Operation = {
      operationId: base64UrlEncode(concurrentPrepared.operation.body.operationId),
      authorDeviceId: deviceId,
      epochId: base64UrlEncode(device.epoch.body.epochId),
      type: "key-epoch",
      envelope: base64UrlEncode(encodeOperation(concurrentPrepared.operation)),
      signature: base64UrlEncode(randomBytes(64)),
    }
    const concurrent = await directFetch("https://example.test/v1/operations", {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify({
        ...concurrentUnsigned,
        signature: await sign(signingKey, operationSigningMessage(concurrentUnsigned)),
      }),
    })
    expect(concurrent.status).toBe(409)
    await expect(concurrent.json()).resolves.toMatchObject({
      error: { code: "epoch_transition_conflict" },
    })

    await runInDurableObject(primaryStub, async (_instance, state) => {
      const vault = state.storage.sql
        .exec<{
          current_epoch_id: string
          epoch_sequence: number
          epoch_transition_cursor: number
          recovery_state_id: string
        }>(
          `SELECT current_epoch_id, epoch_sequence, epoch_transition_cursor, recovery_state_id
           FROM vault_state WHERE singleton = 1`,
        )
        .one()
      expect(vault).toMatchObject({
        current_epoch_id: base64UrlEncode(prepared.nextEpochId),
        epoch_sequence: 1,
        epoch_transition_cursor: 1,
      })
      expect(vault.recovery_state_id).not.toBe(recovery.recoveryStateId)
    })

    const staleIdentifier = operationId(randomBytes(16))
    const staleSigned = signOperation(
      {
        type: "revision",
        operationId: staleIdentifier,
        vaultId: device.vaultId,
        epochId: device.epoch.body.epochId,
        authorDeviceId: device.deviceId,
        fileId: fileId(randomBytes(16)),
        revisionId: revisionId(randomBytes(16)),
        wrappedRevisionKey: wrappedRevisionKey(randomBytes(40)),
        metadataNonce: nonce(randomBytes(12)),
        encryptedMetadata: randomBytes(16),
        chunks: [],
        suite: CIPHER_SUITE,
      },
      device.signingPrivateKey,
    )
    const staleUnsigned: Operation = {
      operationId: base64UrlEncode(staleIdentifier),
      authorDeviceId: deviceId,
      epochId: base64UrlEncode(device.epoch.body.epochId),
      type: "revision",
      envelope: base64UrlEncode(encodeOperation(staleSigned)),
      signature: base64UrlEncode(randomBytes(64)),
    }
    const staleResponse = await directFetch("https://example.test/v1/operations", {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify({
        ...staleUnsigned,
        signature: await sign(signingKey, operationSigningMessage(staleUnsigned)),
      }),
    })
    expect(staleResponse.status).toBe(409)
    await expect(staleResponse.json()).resolves.toMatchObject({ error: { code: "stale_epoch" } })

    await runInDurableObject(primaryStub, async (_instance, state) => {
      state.storage.sql.exec("UPDATE sessions SET supports_epoch_transitions = 0")
    })
    const oldClient = await directFetch("https://example.test/v1/changes?after=1", {
      headers: authorization,
    })
    expect(oldClient.status).toBe(426)
  })

  it("records only signed retention acknowledgements on authoritative history", async () => {
    const stub = env.VAULT.get(env.VAULT.idFromName("retention-acknowledgement-test"))
    const directFetch: TestFetch = (url, init) => stub.fetch(new Request(url, init))
    const { deviceId, sessionToken, signingKey, vaultId, device } = await setupAndAuthenticate(
      directFetch,
      "/internal/setup/session",
    )
    const authorization = { authorization: `Bearer ${sessionToken}` }
    const unsigned: RetentionAcknowledgement = {
      deviceId,
      cursor: 0,
      logHash: ZERO_HASH,
      epochId: base64UrlEncode(device.epoch.body.epochId),
      historyRetention: "forever",
      signature: base64UrlEncode(randomBytes(64)),
    }
    const acknowledgement = {
      ...unsigned,
      signature: await sign(signingKey, retentionAcknowledgementSigningMessage(vaultId, unsigned)),
    }
    const first = await directFetch("https://example.test/v1/retention/acknowledgement", {
      method: "PUT",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify(acknowledgement),
    })
    expect(first.status).toBe(200)
    await expect(first.json()).resolves.toMatchObject({ duplicate: false, cursor: 0 })

    const duplicate = await directFetch("https://example.test/v1/retention/acknowledgement", {
      method: "PUT",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify(acknowledgement),
    })
    await expect(duplicate.json()).resolves.toMatchObject({ duplicate: true, cursor: 0 })

    const substituted = await directFetch("https://example.test/v1/retention/acknowledgement", {
      method: "PUT",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify({ ...acknowledgement, logHash: base64UrlEncode(randomBytes(32)) }),
    })
    expect(substituted.status).toBe(409)
    await expect(substituted.json()).resolves.toMatchObject({ error: { code: "log_mismatch" } })

    const storage = await directFetch("https://example.test/v1/storage", {
      headers: authorization,
    })
    await expect(storage.json()).resolves.toMatchObject({
      retentionMode: "forever",
      activeDeviceCount: 1,
      acknowledgedDeviceCount: 1,
      minimumAcknowledgedCursor: 0,
    })
  })

  it("claims once, authenticates, appends idempotently, and proxies private blobs", async () => {
    const { deviceId, sessionToken, signingKey, vaultId, device } = await setupAndAuthenticate()
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

    const missingBlobOperationId = operationId(randomBytes(16))
    const missingBlobRevision = signOperation(
      {
        type: "revision",
        operationId: missingBlobOperationId,
        vaultId: protocolVaultId(base64UrlDecode(vaultId, 16)),
        epochId: device.epoch.body.epochId,
        authorDeviceId: device.deviceId,
        fileId: fileId(randomBytes(16)),
        revisionId: revisionId(randomBytes(16)),
        wrappedRevisionKey: wrappedRevisionKey(randomBytes(40)),
        metadataNonce: nonce(randomBytes(12)),
        encryptedMetadata: randomBytes(16),
        chunks: [
          {
            blobId: protocolBlobId(randomBytes(16)),
            chunkIndex: 0,
            plaintextLength: 1,
            nonce: nonce(randomBytes(12)),
          },
        ],
        suite: CIPHER_SUITE,
      },
      device.signingPrivateKey,
    )
    const missingBlobUnsigned: Operation = {
      operationId: base64UrlEncode(missingBlobOperationId),
      authorDeviceId: deviceId,
      epochId: base64UrlEncode(device.epoch.body.epochId),
      type: "revision",
      envelope: base64UrlEncode(encodeOperation(missingBlobRevision)),
      signature: base64UrlEncode(randomBytes(64)),
    }
    const missingBlob = await SELF.fetch("https://example.test/v1/operations", {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify({
        ...missingBlobUnsigned,
        signature: await sign(signingKey, operationSigningMessage(missingBlobUnsigned)),
      }),
    })
    expect(missingBlob.status).toBe(409)
    await expect(missingBlob.json()).resolves.toMatchObject({
      error: { code: "blob_not_stored" },
    })

    const operationIdentifier = operationId(randomBytes(16))
    const signedRevision = signOperation(
      {
        type: "revision",
        operationId: operationIdentifier,
        vaultId: device.vaultId,
        epochId: device.epoch.body.epochId,
        authorDeviceId: device.deviceId,
        fileId: fileId(randomBytes(16)),
        revisionId: revisionId(randomBytes(16)),
        wrappedRevisionKey: wrappedRevisionKey(randomBytes(40)),
        metadataNonce: nonce(randomBytes(12)),
        encryptedMetadata: randomBytes(16),
        chunks: [],
        suite: CIPHER_SUITE,
      },
      device.signingPrivateKey,
    )
    const unsignedOperation: Operation = {
      operationId: base64UrlEncode(operationIdentifier),
      authorDeviceId: deviceId,
      epochId: base64UrlEncode(device.epoch.body.epochId),
      type: "revision",
      envelope: base64UrlEncode(encodeOperation(signedRevision)),
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
    expect(firstCommitResult.chainHash).toBe(
      base64UrlEncode(
        await sha256(
          logEntryHashInput(
            protocolVaultId(base64UrlDecode(vaultId, 16)),
            1,
            hashBytes(base64UrlDecode(ZERO_HASH, 32)),
            signedRevision,
          ),
        ),
      ),
    )

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

    const unauthenticatedStorage = await SELF.fetch("https://example.test/v1/storage")
    expect(unauthenticatedStorage.status).toBe(401)
    const storageResponse = await SELF.fetch("https://example.test/v1/storage", {
      headers: authorization,
    })
    expect(storageResponse.status).toBe(200)
    const storage = (await storageResponse.json()) as {
      totalBytes: number
      blobBytes: number
      databaseBytes: number
      blobCount: number
      operationCount: number
      checkpointCount: number
      snapshotCount: number
      canPrune: boolean
    }
    expect(storage).toMatchObject({
      blobCount: 2,
      operationCount: 1,
      checkpointCount: 1,
      snapshotCount: 0,
      canPrune: true,
    })
    expect(storage.blobBytes).toBe(2048)
    expect(storage.databaseBytes).toBeGreaterThan(0)
    expect(storage.totalBytes).toBe(storage.blobBytes + storage.databaseBytes)

    const blobSize = 2 * 1024 * 1024
    const quotaBytes = storage.totalBytes + 6 * 1024 * 1024
    const configured = await SELF.fetch("https://example.test/v1/storage/policy", {
      method: "PUT",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify({ quotaBytes }),
    })
    expect(configured.status).toBe(200)
    const quotaUploads = await Promise.all(
      [randomToken(18), randomToken(18)].map((quotaBlobId) =>
        SELF.fetch(`https://example.test/v1/blobs/${quotaBlobId}`, {
          method: "PUT",
          headers: { ...authorization, "content-type": "application/octet-stream" },
          body: new Uint8Array(blobSize),
        }),
      ),
    )
    expect(quotaUploads.map((response) => response.status).sort()).toEqual([201, 507])
    const rejectedQuotaUpload = quotaUploads.find((response) => response.status === 507)
    await expect(rejectedQuotaUpload?.json()).resolves.toMatchObject({
      error: { code: "storage_quota_exceeded" },
    })
    const pressuredUsageResponse = await SELF.fetch("https://example.test/v1/storage", {
      headers: authorization,
    })
    const pressuredUsage = (await pressuredUsageResponse.json()) as { totalBytes: number }
    const contentLimit = pressuredUsage.totalBytes + 2 * 1024 * 1024 + 256 * 1024
    const tightenQuota = await SELF.fetch("https://example.test/v1/storage/policy", {
      method: "PUT",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify({ quotaBytes: contentLimit }),
    })
    expect(tightenQuota.status).toBe(200)
    const blockedOperationId = operationId(randomBytes(16))
    const blockedRevision = signOperation(
      {
        type: "revision",
        operationId: blockedOperationId,
        vaultId: protocolVaultId(base64UrlDecode(vaultId, 16)),
        epochId: device.epoch.body.epochId,
        authorDeviceId: device.deviceId,
        fileId: fileId(randomBytes(16)),
        revisionId: revisionId(randomBytes(16)),
        wrappedRevisionKey: wrappedRevisionKey(randomBytes(40)),
        metadataNonce: nonce(randomBytes(12)),
        encryptedMetadata: randomBytes(16),
        chunks: [],
        suite: CIPHER_SUITE,
      },
      device.signingPrivateKey,
    )
    const blockedUnsigned: Operation = {
      operationId: base64UrlEncode(blockedOperationId),
      authorDeviceId: deviceId,
      epochId: base64UrlEncode(device.epoch.body.epochId),
      type: "revision",
      envelope: base64UrlEncode(encodeOperation(blockedRevision)),
      signature: base64UrlEncode(randomBytes(64)),
    }
    const blockedCommit = await SELF.fetch("https://example.test/v1/operations", {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify({
        ...blockedUnsigned,
        signature: await sign(signingKey, operationSigningMessage(blockedUnsigned)),
      }),
    })
    expect(blockedCommit.status).toBe(507)
    await expect(blockedCommit.json()).resolves.toMatchObject({
      error: { code: "storage_quota_exceeded" },
    })

    const tooSmallQuota = await SELF.fetch("https://example.test/v1/storage/policy", {
      method: "PUT",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify({ quotaBytes: 1 }),
    })
    expect(tooSmallQuota.status).toBe(409)
    const unlimited = await SELF.fetch("https://example.test/v1/storage/policy", {
      method: "PUT",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify({ quotaBytes: null }),
    })
    expect(unlimited.status).toBe(200)

    const unsafePrune = await SELF.fetch("https://example.test/v1/storage/prune-orphans", {
      method: "POST",
      headers: authorization,
    })
    expect(unsafePrune.status).toBe(200)
    await expect(unsafePrune.json()).resolves.toMatchObject({
      deletedBytes: 0,
      deletedCount: 0,
    })
    const preservedBlob = await SELF.fetch(`https://example.test/v1/blobs/${blobId}`, {
      headers: authorization,
    })
    expect(preservedBlob.status).toBe(200)

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

    const pairingStub = env.VAULT.get(env.VAULT.idFromName("primary"))
    await runInDurableObject(pairingStub, async (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE pairings SET expires_at = ? WHERE pairing_id = ?",
        Date.now() - 1,
        pairing.pairingId,
      )
    })
    const expiredReleaseReplay = await SELF.fetch(
      `https://example.test/v1/pairings/${pairing.pairingId}/release`,
      {
        method: "POST",
        headers: { ...authorization, "content-type": "application/json" },
        body: JSON.stringify(release),
      },
    )
    expect(expiredReleaseReplay.status).toBe(200)
    const expiredConflictingRelease = await SELF.fetch(
      `https://example.test/v1/pairings/${pairing.pairingId}/release`,
      {
        method: "POST",
        headers: { ...authorization, "content-type": "application/json" },
        body: JSON.stringify({ ...release, hpkeTransfer: base64UrlEncode(randomBytes(32)) }),
      },
    )
    expect(expiredConflictingRelease.status).toBe(409)

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
    const ownerRevocation = await signedRevocation(
      signingKey,
      vaultId,
      deviceId,
      base64UrlEncode(device.epoch.body.epochId),
      ownerRevocationTarget,
    )
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

    const selfRevocation = await signedRevocation(
      candidateKey,
      vaultId,
      candidateId,
      base64UrlEncode(device.epoch.body.epochId),
      candidateId,
    )
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
