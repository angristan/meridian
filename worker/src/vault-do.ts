import type {
  AuthChallengeSchema,
  CreatePairingSchema,
  DeviceDescriptorSchema,
  PairingCancelSchema,
  PairingCandidateConfirmationSchema,
  PairingResultSchema,
  RevokeDeviceSchema,
  AuthSession,
  Checkpoint,
  Operation,
  PairingApproval,
  PairingJoin,
  PairingRelease,
  RecoveryClaim,
  RetentionAcknowledgement,
  SetupClaim,
  Snapshot,
} from "@meridian/protocol"
import { DurableObject } from "cloudflare:workers"
import { errorResponse, HttpError } from "./errors"
import { VaultBlobs } from "./vault/blobs"
import { authenticate, type TransactionSync, vaultState } from "./vault/domain"
import { migrateVaultSchema } from "./vault/migrations"
import { VaultNotifications } from "./vault/notifications"
import { VaultOperations } from "./vault/operations"
import { VaultPairing } from "./vault/pairing"
import { VaultRecords } from "./vault/records"
import { VaultRecovery } from "./vault/recovery"
import { runRpc } from "./vault/rpc"
import { VaultSessions } from "./vault/sessions"
import { VaultSetup } from "./vault/setup"

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

type AuthChallenge = typeof AuthChallengeSchema.Type
type CreatePairing = typeof CreatePairingSchema.Type
type DeviceDescriptor = typeof DeviceDescriptorSchema.Type
type PairingCancel = typeof PairingCancelSchema.Type
type PairingCandidateConfirmation = typeof PairingCandidateConfirmationSchema.Type
type PairingResult = typeof PairingResultSchema.Type
type RevokeDevice = typeof RevokeDeviceSchema.Type

export class VaultDurableObject extends DurableObject<VaultDurableObjectEnv> {
  private readonly sql: SqlStorage
  private readonly initialized: Promise<void>
  private readonly setup: VaultSetup
  private readonly sessions: VaultSessions
  private readonly recovery: VaultRecovery
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
    this.setup = new VaultSetup(this.sql, transactionSync)
    this.sessions = new VaultSessions(this.sql, transactionSync)
    this.recovery = new VaultRecovery(this.sql, transactionSync, () =>
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

  status() {
    return this.invoke(() => {
      const state = vaultState(this.sql)
      return { body: { claimed: state !== undefined, cursor: state?.cursor ?? 0 }, status: 200 }
    })
  }

  createSetupSession() {
    return this.invoke(() => this.setup.createSetupSession())
  }

  claimSetup(claim: SetupClaim) {
    return this.invoke(() => this.setup.claim(claim))
  }

  createAuthChallenge(input: AuthChallenge) {
    return this.invoke(() => this.sessions.createAuthChallenge(input))
  }

  createAuthSession(input: AuthSession) {
    return this.invoke(() => this.sessions.createAuthSession(input))
  }

  recoveryPackage() {
    return this.invoke(() => this.recovery.recoveryPackage())
  }

  createRecoveryChallenge() {
    return this.invoke(() => this.recovery.createRecoveryChallenge())
  }

  recover(input: RecoveryClaim) {
    return this.invoke(() => this.recovery.recover(input))
  }

  listDevices(token: string) {
    return this.invoke(() => this.pairing.listDevices(token))
  }

  updateDeviceDescriptor(token: string, input: DeviceDescriptor) {
    return this.invoke(() => this.pairing.updateDeviceDescriptor(token, input))
  }

  revokeDevice(token: string, targetDeviceId: string, input: RevokeDevice) {
    return this.invoke(() => this.operations.revokeDevice(token, targetDeviceId, input))
  }

  createPairing(token: string, input: CreatePairing) {
    return this.invoke(() => this.pairing.createPairing(token, input))
  }

  pairingStatus(token: string, pairingId: string) {
    return this.invoke(() => this.pairing.pairingStatus(token, pairingId))
  }

  pairingProgress(pairingId: string, input: PairingResult) {
    return this.invoke(() => this.pairing.pairingProgress(pairingId, input))
  }

  joinPairing(pairingId: string, input: PairingJoin) {
    return this.invoke(() => this.pairing.joinPairing(pairingId, input))
  }

  approvePairing(token: string, pairingId: string, input: PairingApproval) {
    return this.invoke(() => this.pairing.approvePairing(token, pairingId, input))
  }

  releasePairing(token: string, pairingId: string, input: PairingRelease) {
    return this.invoke(() => this.pairing.releasePairing(token, pairingId, input))
  }

  pairingResult(pairingId: string, input: PairingResult) {
    return this.invoke(() => this.pairing.pairingResult(pairingId, input))
  }

  confirmPairingOwner(token: string, pairingId: string) {
    return this.invoke(() => this.pairing.confirmOwner(token, pairingId))
  }

  confirmPairingCandidate(pairingId: string, input: PairingCandidateConfirmation) {
    return this.invoke(() => this.pairing.confirmCandidate(pairingId, input))
  }

  completePairing(pairingId: string, input: PairingCandidateConfirmation) {
    return this.invoke(() => this.pairing.completePairing(pairingId, input))
  }

  cancelPairing(pairingId: string, input: PairingCancel) {
    return this.invoke(() => this.pairing.cancelPairing(pairingId, input))
  }

  rejectPairing(token: string, pairingId: string) {
    return this.invoke(() => this.pairing.rejectPairing(token, pairingId))
  }

  commitOperation(token: string, operation: Operation) {
    return this.invoke(() => this.operations.commitOperation(token, operation))
  }

  putCheckpoint(token: string, checkpoint: Checkpoint) {
    return this.invoke(() => this.records.putCheckpoint(token, checkpoint))
  }

  latestCheckpoint(token: string) {
    return this.invoke(() => this.records.latestCheckpoint(token))
  }

  acknowledgeRetention(token: string, acknowledgement: RetentionAcknowledgement) {
    return this.invoke(() => this.records.acknowledgeRetention(token, acknowledgement))
  }

  putSnapshot(token: string, snapshot: Snapshot) {
    return this.invoke(() => this.records.putSnapshot(token, snapshot))
  }

  getSnapshot(token: string, snapshotId: string | null) {
    return this.invoke(() => this.records.getSnapshot(token, snapshotId))
  }

  changes(token: string, after: number, limit: number, afterHash: string | null) {
    return this.invoke(() => this.operations.changes(token, after, limit, afterHash))
  }

  storageStats(token: string) {
    return this.invoke(() => this.blobs.storageStats(token))
  }

  pruneOrphanBlobs(token: string) {
    return this.invoke(() => this.blobs.pruneOrphanBlobs(token))
  }

  accessBlob(token: string, blobId: string) {
    return this.invoke(() => this.blobs.accessBlob(token, blobId))
  }

  claimBlob(token: string, blobId: string, expectedSize: number) {
    return this.invoke(() => this.blobs.claimBlob(token, blobId, expectedSize))
  }

  finalizeBlob(token: string, blobId: string, expectedSize: number) {
    return this.invoke(() => this.blobs.finalizeBlob(token, blobId, expectedSize))
  }

  override async fetch(request: Request): Promise<Response> {
    try {
      await this.initialized
      const { pathname } = new URL(request.url)
      if (request.method !== "GET" || pathname !== "/v1/notifications") {
        throw new HttpError(404, "not_found", "Route not found")
      }

      const authorization = request.headers.get("authorization") ?? ""
      const token = /^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(authorization)?.at(1) ?? ""
      const session = await authenticate(this.sql, token)
      return this.notifications.websocket(request, session)
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

  private invoke<T>(operation: () => T | Promise<T>) {
    return runRpc(async () => {
      await this.initialized
      return operation()
    })
  }
}
