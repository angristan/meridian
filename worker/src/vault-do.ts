import { DurableObject } from "cloudflare:workers"
import { errorResponse, HttpError } from "./errors"
import { VaultAuth } from "./vault/auth"
import { VaultBlobs } from "./vault/blobs"
import { authenticate, json, type TransactionSync, vaultState } from "./vault/domain"
import { migrateVaultSchema } from "./vault/migrations"
import { VaultNotifications } from "./vault/notifications"
import { VaultOperations } from "./vault/operations"
import { VaultPairing } from "./vault/pairing"
import { VaultRecords } from "./vault/records"

export {
  authSigningMessage,
  checkpointSigningMessage,
  operationSigningMessage,
  pairingApprovalSigningMessage,
  pairingJoinSigningMessage,
  retentionAcknowledgementSigningMessage,
  setupClaimSigningMessage,
  snapshotSigningMessage,
} from "./vault/signing"

export type VaultDurableObjectEnv = Pick<Env, "BLOBS">

export class VaultDurableObject extends DurableObject<VaultDurableObjectEnv> {
  private readonly sql: SqlStorage
  private readonly initialized: Promise<void>
  private readonly auth: VaultAuth
  private readonly blobs: VaultBlobs
  private readonly pairing: VaultPairing
  private readonly operations: VaultOperations
  private readonly records: VaultRecords
  private readonly notifications: VaultNotifications

  constructor(ctx: DurableObjectState, env: VaultDurableObjectEnv) {
    super(ctx, env)
    this.sql = ctx.storage.sql
    const transactionSync: TransactionSync = (callback) => ctx.storage.transactionSync(callback)
    this.initialized = ctx.blockConcurrencyWhile(async () =>
      migrateVaultSchema(this.sql, transactionSync),
    )
    this.notifications = new VaultNotifications(ctx, this.sql)
    this.auth = new VaultAuth(this.sql, transactionSync, () =>
      this.notifications.closeForRecovery(),
    )
    this.blobs = new VaultBlobs(this.sql, env.BLOBS, transactionSync)
    this.pairing = new VaultPairing(this.sql, transactionSync)
    this.operations = new VaultOperations(
      this.sql,
      transactionSync,
      (cursor, authorDeviceId) => this.notifications.notifyCursor(cursor, authorDeviceId),
      (deviceId) => this.notifications.closeRevokedDevice(deviceId),
      this.blobs,
    )
    this.records = new VaultRecords(this.sql)
  }

  override async fetch(request: Request): Promise<Response> {
    try {
      await this.initialized
      const { pathname } = new URL(request.url)

      if (request.method === "GET" && pathname === "/internal/status") {
        const state = vaultState(this.sql)
        return json({ claimed: state !== undefined, cursor: state?.cursor ?? 0 })
      }
      if (request.method === "POST" && pathname === "/internal/setup/session")
        return await this.auth.createSetupSession()
      if (request.method === "POST" && pathname === "/v1/setup/claim")
        return await this.auth.claim(request)
      if (request.method === "POST" && pathname === "/v1/auth/challenge")
        return await this.auth.createAuthChallenge(request)
      if (request.method === "POST" && pathname === "/v1/auth/session")
        return await this.auth.createAuthSession(request)
      if (request.method === "GET" && pathname === "/v1/recovery/package")
        return this.auth.recoveryPackage()
      if (request.method === "POST" && pathname === "/v1/recovery/challenge")
        return await this.auth.createRecoveryChallenge()
      if (request.method === "POST" && pathname === "/v1/recovery/claim")
        return await this.auth.recover(request)
      if (request.method === "POST" && pathname === "/internal/auth/validate")
        return json(await authenticate(this.sql, request))
      if (request.method === "GET" && pathname === "/v1/devices")
        return await this.pairing.listDevices(request)
      if (request.method === "PUT" && pathname === "/v1/device/descriptor")
        return await this.pairing.updateDeviceDescriptor(request)

      const revokeMatch = /^\/v1\/devices\/([^/]+)\/revoke$/.exec(pathname)
      const revokeId = revokeMatch?.at(1)
      if (request.method === "POST" && revokeId !== undefined)
        return await this.operations.revokeDevice(request, revokeId)
      if (request.method === "POST" && pathname === "/v1/pairings")
        return await this.pairing.createPairing(request)
      if (request.method === "GET" && pathname === "/v1/changes")
        return await this.operations.changes(request)
      if (request.method === "GET" && pathname === "/v1/storage")
        return await this.blobs.storageStats(request)
      if (request.method === "POST" && pathname === "/v1/storage/prune-orphans") {
        return await this.ctx.blockConcurrencyWhile(async () => {
          try {
            return await this.blobs.pruneOrphanBlobs(request)
          } catch (error) {
            return errorResponse(error)
          }
        })
      }
      const blobClaimMatch = /^\/internal\/blobs\/([^/]+)\/claim$/.exec(pathname)
      const claimedBlobId = blobClaimMatch?.at(1)
      if (request.method === "POST" && claimedBlobId !== undefined)
        return await this.blobs.claimBlob(request, claimedBlobId)
      const blobFinalizeMatch = /^\/internal\/blobs\/([^/]+)\/finalize$/.exec(pathname)
      const finalizedBlobId = blobFinalizeMatch?.at(1)
      if (request.method === "POST" && finalizedBlobId !== undefined)
        return await this.blobs.finalizeBlob(request, finalizedBlobId)
      if (request.method === "POST" && pathname === "/v1/operations")
        return await this.operations.commitOperation(request)
      if (request.method === "PUT" && pathname === "/v1/checkpoints")
        return await this.records.putCheckpoint(request)
      if (request.method === "GET" && pathname === "/v1/checkpoints/latest")
        return await this.records.latestCheckpoint(request)
      if (request.method === "PUT" && pathname === "/v1/retention/acknowledgement")
        return await this.records.acknowledgeRetention(request)
      if (request.method === "PUT" && pathname === "/v1/snapshot")
        return await this.records.putSnapshot(request)
      if (request.method === "GET" && pathname === "/v1/snapshot")
        return await this.records.getSnapshot(request)
      if (request.method === "GET" && pathname === "/v1/notifications") {
        const session = await authenticate(this.sql, request)
        return this.notifications.websocket(request, session)
      }

      const pairingMatch = /^\/v1\/pairings\/([^/]+)$/.exec(pathname)
      const pairingId = pairingMatch?.at(1)
      if (request.method === "GET" && pairingId !== undefined)
        return await this.pairing.pairingStatus(request, pairingId)
      const progressMatch = /^\/v1\/pairings\/([^/]+)\/status$/.exec(pathname)
      const progressId = progressMatch?.at(1)
      if (request.method === "POST" && progressId !== undefined)
        return await this.pairing.pairingProgress(request, progressId)
      const joinMatch = /^\/v1\/pairings\/([^/]+)\/join$/.exec(pathname)
      const joinId = joinMatch?.at(1)
      if (request.method === "POST" && joinId !== undefined)
        return await this.pairing.joinPairing(request, joinId)
      const approveMatch = /^\/v1\/pairings\/([^/]+)\/approve$/.exec(pathname)
      const approveId = approveMatch?.at(1)
      if (request.method === "POST" && approveId !== undefined)
        return await this.pairing.approvePairing(request, approveId)
      const releaseMatch = /^\/v1\/pairings\/([^/]+)\/release$/.exec(pathname)
      const releaseId = releaseMatch?.at(1)
      if (request.method === "POST" && releaseId !== undefined)
        return await this.pairing.releasePairing(request, releaseId)
      const resultMatch = /^\/v1\/pairings\/([^/]+)\/result$/.exec(pathname)
      const resultId = resultMatch?.at(1)
      if (request.method === "POST" && resultId !== undefined)
        return await this.pairing.pairingResult(request, resultId)
      const ownerConfirmationMatch = /^\/v1\/pairings\/([^/]+)\/confirm-owner$/.exec(pathname)
      const ownerConfirmationId = ownerConfirmationMatch?.at(1)
      if (request.method === "POST" && ownerConfirmationId !== undefined)
        return await this.pairing.confirmOwner(request, ownerConfirmationId)
      const candidateConfirmationMatch = /^\/v1\/pairings\/([^/]+)\/confirm-candidate$/.exec(
        pathname,
      )
      const candidateConfirmationId = candidateConfirmationMatch?.at(1)
      if (request.method === "POST" && candidateConfirmationId !== undefined)
        return await this.pairing.confirmCandidate(request, candidateConfirmationId)
      const completionMatch = /^\/v1\/pairings\/([^/]+)\/complete$/.exec(pathname)
      const completionId = completionMatch?.at(1)
      if (request.method === "POST" && completionId !== undefined)
        return await this.pairing.completePairing(request, completionId)
      const cancelMatch = /^\/v1\/pairings\/([^/]+)\/cancel$/.exec(pathname)
      const cancelId = cancelMatch?.at(1)
      if (request.method === "POST" && cancelId !== undefined)
        return await this.pairing.cancelPairing(request, cancelId)
      const rejectMatch = /^\/v1\/pairings\/([^/]+)\/reject$/.exec(pathname)
      const rejectId = rejectMatch?.at(1)
      if (request.method === "POST" && rejectId !== undefined)
        return await this.pairing.rejectPairing(request, rejectId)

      throw new HttpError(404, "not_found", "Route not found")
    } catch (error) {
      return errorResponse(error)
    }
  }

  override async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    this.notifications.webSocketMessage(socket, message)
  }

  override async webSocketClose(
    _socket: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    // The socket is already closed; echoing reserved codes such as 1006 would throw.
  }

  override async webSocketError(socket: WebSocket): Promise<void> {
    this.notifications.webSocketError(socket)
  }
}
