import { env, runInDurableObject } from "cloudflare:test"
import {
  createFirstDeviceClaimBundle,
  serializeEncryptedRecoveryPackage,
  sign as signBytes,
  signOperation,
} from "@meridian/crypto"
import {
  CIPHER_SUITE,
  type Ed25519PrivateKey,
  encodeDeviceCertificate,
  encodeOperation,
  fileId,
  nonce,
  operationId,
  type Operation,
  revisionId,
  type SetupClaim,
  wrappedRevisionKey,
  blobId as protocolBlobId,
} from "@meridian/protocol"
import { describe, expect, it } from "vitest"
import { base64UrlEncode, randomToken } from "../src/encoding"
import { HttpError } from "../src/errors"
import { VaultBlobs } from "../src/vault/blobs"
import type { TransactionSync } from "../src/vault/domain"
import { VaultOperations } from "../src/vault/operations"
import {
  authSigningMessage,
  operationSigningMessage,
  setupClaimSigningMessage,
} from "../src/vault-do"

function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return bytes
}

function sign(message: Uint8Array, privateKey: Ed25519PrivateKey): string {
  return base64UrlEncode(signBytes(message, privateKey))
}

async function setupOwner(stub: DurableObjectStub): Promise<{
  device: Awaited<ReturnType<typeof createFirstDeviceClaimBundle>>["device"]
  deviceId: string
  sessionToken: string
  vaultId: string
}> {
  const first = await createFirstDeviceClaimBundle()
  const deviceId = base64UrlEncode(first.device.deviceId)
  const vaultId = base64UrlEncode(first.device.vaultId)
  const setupResponse = await stub.fetch(
    new Request("https://vault.internal/internal/setup/session", { method: "POST" }),
  )
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
      signingPublicKey: base64UrlEncode(first.device.signingPublicKey),
      hpkePublicKey: base64UrlEncode(first.device.hpkePublicKey),
      certificate: base64UrlEncode(encodeDeviceCertificate(first.device.certificate)),
    },
    proof: base64UrlEncode(randomBytes(64)),
  }
  const claim: SetupClaim = {
    ...unsignedClaim,
    proof: sign(
      setupClaimSigningMessage(unsignedClaim, setup.claimChallenge),
      first.device.signingPrivateKey,
    ),
  }
  const claimResponse = await stub.fetch(
    new Request("https://vault.internal/v1/setup/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(claim),
    }),
  )
  expect(claimResponse.status).toBe(201)

  const challengeResponse = await stub.fetch(
    new Request("https://vault.internal/v1/auth/challenge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceId }),
    }),
  )
  const challenge = (await challengeResponse.json()) as {
    challengeId: string
    challenge: string
  }
  const authInput = {
    deviceId,
    challengeId: challenge.challengeId,
    signature: base64UrlEncode(randomBytes(64)),
  }
  authInput.signature = sign(
    authSigningMessage(vaultId, authInput, challenge.challenge),
    first.device.signingPrivateKey,
  )
  const sessionResponse = await stub.fetch(
    new Request("https://vault.internal/v1/auth/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(authInput),
    }),
  )
  const session = (await sessionResponse.json()) as { sessionToken: string }
  return { device: first.device, deviceId, sessionToken: session.sessionToken, vaultId }
}

type OwnerContext = Awaited<ReturnType<typeof setupOwner>>

function signedBlobOperation(
  owner: OwnerContext,
  blobIdentifier: ReturnType<typeof protocolBlobId>,
): Operation {
  const operationIdentifier = operationId(randomBytes(16))
  const signedRevision = signOperation(
    {
      type: "revision",
      operationId: operationIdentifier,
      vaultId: owner.device.vaultId,
      epochId: owner.device.epoch.body.epochId,
      authorDeviceId: owner.device.deviceId,
      fileId: fileId(randomBytes(16)),
      revisionId: revisionId(randomBytes(16)),
      wrappedRevisionKey: wrappedRevisionKey(randomBytes(40)),
      metadataNonce: nonce(randomBytes(12)),
      encryptedMetadata: randomBytes(16),
      chunks: [
        {
          blobId: blobIdentifier,
          chunkIndex: 0,
          plaintextLength: 1,
          nonce: nonce(randomBytes(12)),
        },
      ],
      suite: CIPHER_SUITE,
    },
    owner.device.signingPrivateKey,
  )
  const unsignedOperation: Operation = {
    operationId: base64UrlEncode(operationIdentifier),
    authorDeviceId: owner.deviceId,
    epochId: base64UrlEncode(owner.device.epoch.body.epochId),
    type: "revision",
    envelope: base64UrlEncode(encodeOperation(signedRevision)),
    signature: base64UrlEncode(randomBytes(64)),
  }
  return {
    ...unsignedOperation,
    signature: sign(operationSigningMessage(unsignedOperation), owner.device.signingPrivateKey),
  }
}

async function commitStatus(
  operations: VaultOperations,
  owner: OwnerContext,
  operation: Operation,
): Promise<number> {
  try {
    return (
      await operations.commitOperation(
        new Request("https://vault.internal/v1/operations", {
          method: "POST",
          headers: {
            authorization: `Bearer ${owner.sessionToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(operation),
        }),
      )
    ).status
  } catch (error) {
    if (!(error instanceof HttpError)) throw error
    return error.status
  }
}

class PausedDeleteBucket {
  private readonly objects = new Map<string, { bytes: Uint8Array; uploaded: Date }>()
  private markDeleteStarted: (() => void) | undefined
  private releasePendingDelete: (() => void) | undefined
  private nextDeleteError: Error | undefined
  readonly deleteStarted = new Promise<void>((resolve) => {
    this.markDeleteStarted = resolve
  })
  private readonly deleteGate = new Promise<void>((resolve) => {
    this.releasePendingDelete = resolve
  })
  private headPause: { reached: () => void; wait: Promise<void> } | undefined

  seed(key: string, bytes: Uint8Array): void {
    this.objects.set(key, { bytes, uploaded: new Date(0) })
  }

  releaseDelete(): void {
    this.releasePendingDelete?.()
  }

  failNextDelete(error = new Error("Injected R2 deletion failure")): void {
    this.nextDeleteError = error
  }

  pauseNextHead(): { reached: Promise<void>; release: () => void } {
    let markReached: (() => void) | undefined
    let release: (() => void) | undefined
    const reached = new Promise<void>((resolve) => {
      markReached = resolve
    })
    const wait = new Promise<void>((resolve) => {
      release = resolve
    })
    this.headPause = { reached: () => markReached?.(), wait }
    return { reached, release: () => release?.() }
  }

  async head(key: string): Promise<R2Object | null> {
    const object = this.objects.get(key)
    if (!object) return null
    const response = {
      key,
      size: object.bytes.byteLength,
      uploaded: object.uploaded,
    } as R2Object
    const pause = this.headPause
    if (pause) {
      this.headPause = undefined
      pause.reached()
      await pause.wait
    }
    return response
  }

  async list(options: R2ListOptions): Promise<R2Objects> {
    const objects = [...this.objects]
      .filter(([key]) => key.startsWith(options.prefix ?? ""))
      .map(([key, object]) => ({
        key,
        size: object.bytes.byteLength,
        uploaded: object.uploaded,
      })) as R2Object[]
    return { objects, truncated: false, delimitedPrefixes: [] } as R2Objects
  }

  async delete(keys: string | string[]): Promise<void> {
    this.markDeleteStarted?.()
    await this.deleteGate
    const error = this.nextDeleteError
    this.nextDeleteError = undefined
    if (error) throw error
    for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key)
  }
}

describe("deterministic Worker fault injection", () => {
  it("does not globally serialize R2 deletion", async () => {
    const stub = env.VAULT.get(env.VAULT.idFromName(`blob-prune-availability-${randomToken(8)}`))
    const owner = await setupOwner(stub)

    await runInDurableObject(stub, async (instance, state) => {
      const transactionSync: TransactionSync = (callback) => state.storage.transactionSync(callback)
      const bucket = new PausedDeleteBucket()
      const blobIdentifier = protocolBlobId(randomBytes(16))
      const blobId = base64UrlEncode(blobIdentifier)
      bucket.seed(`vaults/${owner.vaultId}/blobs/${blobId}`, new Uint8Array([1, 2, 3]))

      const injectable = instance as unknown as { blobs: VaultBlobs }
      let requestTimeConcurrencyBlocks = 0
      const mutableState = state as unknown as {
        blockConcurrencyWhile: DurableObjectState["blockConcurrencyWhile"]
      }
      const blockConcurrencyWhile = mutableState.blockConcurrencyWhile.bind(state)
      mutableState.blockConcurrencyWhile = (callback) => {
        requestTimeConcurrencyBlocks += 1
        return blockConcurrencyWhile(callback)
      }
      injectable.blobs = new VaultBlobs(
        state.storage.sql,
        bucket as unknown as R2Bucket,
        transactionSync,
      )

      const authorization = { authorization: `Bearer ${owner.sessionToken}` }
      const pruning = instance.fetch(
        new Request("https://vault.internal/v1/storage/prune-orphans", {
          method: "POST",
          headers: authorization,
        }),
      )
      await bucket.deleteStarted
      const changes = await instance.fetch(
        new Request("https://vault.internal/v1/changes?after=0", { headers: authorization }),
      )

      bucket.releaseDelete()
      expect(requestTimeConcurrencyBlocks).toBe(0)
      expect(changes.status).toBe(200)
      expect((await pruning).status).toBe(200)
    })
  })

  it("never commits a revision while pruning its blob", async () => {
    const stub = env.VAULT.get(env.VAULT.idFromName(`blob-prune-race-${randomToken(8)}`))
    const owner = await setupOwner(stub)

    await runInDurableObject(stub, async (_instance, state) => {
      const transactionSync: TransactionSync = (callback) => state.storage.transactionSync(callback)
      const bucket = new PausedDeleteBucket()
      const blobIdentifier = protocolBlobId(randomBytes(16))
      const blobId = base64UrlEncode(blobIdentifier)
      const blobKey = `vaults/${owner.vaultId}/blobs/${blobId}`
      bucket.seed(blobKey, new Uint8Array([1, 2, 3]))
      const blobs = new VaultBlobs(
        state.storage.sql,
        bucket as unknown as R2Bucket,
        transactionSync,
      )
      const operations = new VaultOperations(
        state.storage.sql,
        transactionSync,
        () => {},
        () => {},
        blobs,
      )
      const authorization = { authorization: `Bearer ${owner.sessionToken}` }
      const pruning = blobs.pruneOrphanBlobs(
        new Request("https://vault.internal/v1/storage/prune", { headers: authorization }),
      )
      await bucket.deleteStarted

      const commitResult = await commitStatus(
        operations,
        owner,
        signedBlobOperation(owner, blobIdentifier),
      )
      bucket.releaseDelete()
      await pruning

      const blobExists = (await bucket.head(blobKey)) !== null
      expect(commitResult === 201 && !blobExists).toBe(false)
      const operationCount = state.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM operations")
        .one().count
      expect(operationCount).toBe(commitResult === 201 ? 1 : 0)
    })
  })

  it("clears deletion fences when R2 deletion fails", async () => {
    const stub = env.VAULT.get(env.VAULT.idFromName(`blob-delete-failure-${randomToken(8)}`))
    const owner = await setupOwner(stub)

    await runInDurableObject(stub, async (_instance, state) => {
      const transactionSync: TransactionSync = (callback) => state.storage.transactionSync(callback)
      const bucket = new PausedDeleteBucket()
      const blobIdentifier = protocolBlobId(randomBytes(16))
      const blobId = base64UrlEncode(blobIdentifier)
      const blobKey = `vaults/${owner.vaultId}/blobs/${blobId}`
      bucket.seed(blobKey, new Uint8Array([7, 8, 9]))
      bucket.failNextDelete()
      bucket.releaseDelete()
      const blobs = new VaultBlobs(
        state.storage.sql,
        bucket as unknown as R2Bucket,
        transactionSync,
      )
      const authorization = { authorization: `Bearer ${owner.sessionToken}` }

      await expect(
        blobs.pruneOrphanBlobs(
          new Request("https://vault.internal/v1/storage/prune", { headers: authorization }),
        ),
      ).rejects.toThrow("Injected R2 deletion failure")

      expect(await bucket.head(blobKey)).not.toBeNull()
      expect(
        state.storage.sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM blob_claims WHERE blob_id = ?",
            blobId,
          )
          .one().count,
      ).toBe(0)

      const retry = await blobs.pruneOrphanBlobs(
        new Request("https://vault.internal/v1/storage/prune", { headers: authorization }),
      )
      await expect(retry.json()).resolves.toMatchObject({ deletedCount: 1 })
      expect(await bucket.head(blobKey)).toBeNull()
    })
  })

  it("recovers a fence stranded after R2 deletion", async () => {
    const stub = env.VAULT.get(env.VAULT.idFromName(`blob-delete-crash-${randomToken(8)}`))
    const owner = await setupOwner(stub)

    await runInDurableObject(stub, async (_instance, state) => {
      const durableTransaction: TransactionSync = (callback) =>
        state.storage.transactionSync(callback)
      let transactionCount = 0
      const crashAfterDelete: TransactionSync = (callback) => {
        transactionCount += 1
        if (transactionCount === 2) throw new Error("Injected crash after R2 deletion")
        return durableTransaction(callback)
      }
      const bucket = new PausedDeleteBucket()
      const blobIdentifier = protocolBlobId(randomBytes(16))
      const blobId = base64UrlEncode(blobIdentifier)
      const blobKey = `vaults/${owner.vaultId}/blobs/${blobId}`
      bucket.seed(blobKey, new Uint8Array([10, 11, 12]))
      bucket.releaseDelete()
      const interrupted = new VaultBlobs(
        state.storage.sql,
        bucket as unknown as R2Bucket,
        crashAfterDelete,
      )
      const authorization = { authorization: `Bearer ${owner.sessionToken}` }

      await expect(
        interrupted.pruneOrphanBlobs(
          new Request("https://vault.internal/v1/storage/prune", { headers: authorization }),
        ),
      ).rejects.toThrow("Injected crash after R2 deletion")
      expect(await bucket.head(blobKey)).toBeNull()
      expect(
        state.storage.sql
          .exec<{ expected_size: number }>(
            "SELECT expected_size FROM blob_claims WHERE blob_id = ?",
            blobId,
          )
          .one().expected_size,
      ).toBe(-1)

      const restarted = new VaultBlobs(
        state.storage.sql,
        bucket as unknown as R2Bucket,
        durableTransaction,
      )
      const claim = await restarted.claimBlob(
        new Request(`https://vault.internal/v1/blobs/${blobId}/claim?size=3`, {
          method: "POST",
          headers: authorization,
        }),
        blobId,
      )
      expect(claim.status).toBe(200)
      await expect(claim.json()).resolves.toEqual({ exists: false })
      expect(
        state.storage.sql
          .exec<{ expected_size: number }>(
            "SELECT expected_size FROM blob_claims WHERE blob_id = ?",
            blobId,
          )
          .one().expected_size,
      ).toBe(3)
    })
  })

  it("retries safely after the operation transaction fails", async () => {
    const stub = env.VAULT.get(env.VAULT.idFromName(`blob-commit-failure-${randomToken(8)}`))
    const owner = await setupOwner(stub)

    await runInDurableObject(stub, async (_instance, state) => {
      const durableTransaction: TransactionSync = (callback) =>
        state.storage.transactionSync(callback)
      const bucket = new PausedDeleteBucket()
      const blobIdentifier = protocolBlobId(randomBytes(16))
      const blobId = base64UrlEncode(blobIdentifier)
      const blobKey = `vaults/${owner.vaultId}/blobs/${blobId}`
      bucket.seed(blobKey, new Uint8Array([13, 14, 15]))
      const blobs = new VaultBlobs(
        state.storage.sql,
        bucket as unknown as R2Bucket,
        durableTransaction,
      )
      let failNextTransaction = true
      const failingTransaction: TransactionSync = (callback) => {
        if (failNextTransaction) {
          failNextTransaction = false
          return durableTransaction(() => {
            callback()
            throw new Error("Injected operation transaction failure")
          })
        }
        return durableTransaction(callback)
      }
      const interrupted = new VaultOperations(
        state.storage.sql,
        failingTransaction,
        () => {},
        () => {},
        blobs,
      )
      const operation = signedBlobOperation(owner, blobIdentifier)

      await expect(commitStatus(interrupted, owner, operation)).rejects.toThrow(
        "Injected operation transaction failure",
      )
      expect(
        state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM operations").one()
          .count,
      ).toBe(0)
      expect(
        state.storage.sql.exec<{ cursor: number }>("SELECT cursor FROM vault_state").one().cursor,
      ).toBe(0)
      expect(
        state.storage.sql
          .exec<{ expected_size: number }>(
            "SELECT expected_size FROM blob_claims WHERE blob_id = ?",
            blobId,
          )
          .one().expected_size,
      ).toBe(3)
      expect(await bucket.head(blobKey)).not.toBeNull()

      const restarted = new VaultOperations(
        state.storage.sql,
        durableTransaction,
        () => {},
        () => {},
        blobs,
      )
      expect(await commitStatus(restarted, owner, operation)).toBe(201)
      expect(
        state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM operations").one()
          .count,
      ).toBe(1)
      expect(
        state.storage.sql.exec<{ cursor: number }>("SELECT cursor FROM vault_state").one().cursor,
      ).toBe(1)
      expect(
        state.storage.sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM blob_claims WHERE blob_id = ?",
            blobId,
          )
          .one().count,
      ).toBe(0)
    })
  })

  it("returns the same receipt after a committed response is lost", async () => {
    const stub = env.VAULT.get(env.VAULT.idFromName(`blob-commit-response-${randomToken(8)}`))
    const owner = await setupOwner(stub)

    await runInDurableObject(stub, async (_instance, state) => {
      const transactionSync: TransactionSync = (callback) => state.storage.transactionSync(callback)
      const bucket = new PausedDeleteBucket()
      const blobIdentifier = protocolBlobId(randomBytes(16))
      const blobId = base64UrlEncode(blobIdentifier)
      const blobKey = `vaults/${owner.vaultId}/blobs/${blobId}`
      bucket.seed(blobKey, new Uint8Array([16, 17, 18]))
      const blobs = new VaultBlobs(
        state.storage.sql,
        bucket as unknown as R2Bucket,
        transactionSync,
      )
      const operations = new VaultOperations(
        state.storage.sql,
        transactionSync,
        () => {},
        () => {},
        blobs,
      )
      const operation = signedBlobOperation(owner, blobIdentifier)
      const request = () =>
        new Request("https://vault.internal/v1/operations", {
          method: "POST",
          headers: {
            authorization: `Bearer ${owner.sessionToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(operation),
        })

      await operations.commitOperation(request())
      const committed = state.storage.sql
        .exec<{ chain_hash: string }>("SELECT chain_hash FROM operations WHERE cursor = 1")
        .one()

      const retry = await operations.commitOperation(request())
      expect(retry.status).toBe(200)
      await expect(retry.json()).resolves.toMatchObject({
        cursor: 1,
        chainHash: committed.chain_hash,
        duplicate: true,
      })
      expect(
        state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM operations").one()
          .count,
      ).toBe(1)
      expect(
        state.storage.sql.exec<{ cursor: number }>("SELECT cursor FROM vault_state").one().cursor,
      ).toBe(1)
      expect(
        state.storage.sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM blob_claims WHERE blob_id = ?",
            blobId,
          )
          .one().count,
      ).toBe(0)
      expect(await bucket.head(blobKey)).not.toBeNull()
    })
  })

  it("does not prune a blob reserved before an R2 head response", async () => {
    const stub = env.VAULT.get(env.VAULT.idFromName(`blob-head-race-${randomToken(8)}`))
    const owner = await setupOwner(stub)

    await runInDurableObject(stub, async (_instance, state) => {
      const transactionSync: TransactionSync = (callback) => state.storage.transactionSync(callback)
      const bucket = new PausedDeleteBucket()
      const blobIdentifier = protocolBlobId(randomBytes(16))
      const blobId = base64UrlEncode(blobIdentifier)
      const blobKey = `vaults/${owner.vaultId}/blobs/${blobId}`
      bucket.seed(blobKey, new Uint8Array([4, 5, 6]))
      const blobs = new VaultBlobs(
        state.storage.sql,
        bucket as unknown as R2Bucket,
        transactionSync,
      )
      const operations = new VaultOperations(
        state.storage.sql,
        transactionSync,
        () => {},
        () => {},
        blobs,
      )
      const head = bucket.pauseNextHead()
      const committing = commitStatus(operations, owner, signedBlobOperation(owner, blobIdentifier))
      await head.reached

      const pruning = blobs.pruneOrphanBlobs(
        new Request("https://vault.internal/v1/storage/prune", {
          headers: { authorization: `Bearer ${owner.sessionToken}` },
        }),
      )
      const firstOutcome = await Promise.race([
        pruning.then(() => "prune-complete" as const),
        bucket.deleteStarted.then(() => "delete-started" as const),
      ])
      if (firstOutcome === "delete-started") bucket.releaseDelete()
      head.release()
      const [commitResult, pruneResponse] = await Promise.all([committing, pruning])

      expect(firstOutcome).toBe("prune-complete")
      expect(commitResult).toBe(201)
      expect(await bucket.head(blobKey)).not.toBeNull()
      await expect(pruneResponse.json()).resolves.toMatchObject({ deletedCount: 0 })
    })
  })
})
