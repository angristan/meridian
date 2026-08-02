import type {
  AuthChallengeProof,
  BlobTransferProgress,
  ConfigCategory,
  CryptoPort,
  DecryptedRevision,
  DeviceKeyMaterial,
  DeviceRevocationMaterial,
  DeviceRevocationRecord,
  EncryptedBlob,
  EncryptedRevision,
  EpochTransitionMaterial,
  HistoryRevisionMetadata,
  LogFormat,
  PairedDeviceMaterial,
  PairingApprovalMaterial,
  PairingCapability,
  PairingConfirmationMaterial,
  PairingJoinMaterial,
  PairingResult,
  PairingStatus,
  PairingVerificationMaterial,
  RecoveryPackageMaterial,
  RemoteChanges,
  RemoteDevice,
  RemoteOperation,
  RemotePort,
  RemoteStorageUsage,
  RetentionAcknowledgement,
  RevisionDraft,
  ScannedFileSnapshot,
  SelectiveSyncSettings,
  SetupClaim,
  StoragePruneResult,
  TrustedCheckpoint,
  VaultPort,
  VaultScanOptions,
} from "../src/model"
import { fingerprint } from "../src/platform/bytes"
import { isConfigPath, isSelectedForSync, isSyncablePath } from "../src/vault/path-policy"

export const TEST_DEVICE: DeviceKeyMaterial = {
  vaultId: "vault-1",
  deviceId: "device-local",
  serialized: "secret",
  epochId: "epoch-0",
  epochSequence: 0,
  epochActivatedAtCursor: 0,
  requiredTransitionOperationId: null,
  trustedCheckpoint: { cursor: 0, logHash: "hash-0" },
  trustedCheckpointAuthorized: true,
}

export class FakeVault implements VaultPort {
  readonly files = new Map<string, ArrayBuffer>()
  readonly configDir = ".config"

  constructor(
    initial: Record<string, string> = {},
    private readonly fileSizeLimit = Number.MAX_SAFE_INTEGER,
  ) {
    for (const [path, value] of Object.entries(initial)) {
      this.files.set(path, new TextEncoder().encode(value).buffer)
    }
  }

  maxFileBytes(): number {
    return this.fileSizeLimit
  }

  async listFiles(
    categories: Record<ConfigCategory, boolean>,
    selection: SelectiveSyncSettings = { excludedFolders: [], excludedExtensions: [] },
    options: VaultScanOptions = {},
  ): Promise<ScannedFileSnapshot[]> {
    return this.scanFiles([...this.files.keys()], categories, selection, options)
  }

  async scanFiles(
    paths: readonly string[],
    categories: Record<ConfigCategory, boolean>,
    selection: SelectiveSyncSettings = { excludedFolders: [], excludedExtensions: [] },
    options: VaultScanOptions = {},
  ): Promise<ScannedFileSnapshot[]> {
    const snapshots: ScannedFileSnapshot[] = []
    const candidates = [...new Set(paths)]
    let processed = 0
    for (const path of candidates) {
      if (options.shouldStop?.()) throw new Error("Vault scan canceled")
      const bytes = this.files.get(path)
      if (!bytes) {
        processed += 1
        options.onProgress?.({
          kind: "scan",
          processed,
          total: candidates.length,
          currentPath: path,
        })
        continue
      }
      if (
        !isSyncablePath(path, this.configDir, categories) ||
        !isSelectedForSync(path, this.configDir, selection)
      ) {
        processed += 1
        options.onProgress?.({
          kind: "scan",
          processed,
          total: candidates.length,
          currentPath: path,
        })
        continue
      }
      snapshots.push({
        path,
        fingerprint: await fingerprint(bytes),
        size: bytes.byteLength,
        mtime: 1,
        kind: isConfigPath(path, this.configDir) ? "config" : "vault",
      })
      processed += 1
      options.onProgress?.({
        kind: "scan",
        processed,
        total: candidates.length,
        currentPath: path,
      })
    }
    return snapshots.sort((left, right) => left.path.localeCompare(right.path))
  }

  async read(path: string): Promise<ArrayBuffer> {
    const bytes = this.files.get(path)
    if (!bytes) throw new Error(`Missing ${path}`)
    return bytes.slice(0)
  }

  async write(path: string, bytes: ArrayBuffer): Promise<void> {
    if (bytes.byteLength > this.maxFileBytes()) {
      throw new Error(`${path} exceeds the configured mobile-safe file size limit`)
    }
    this.files.set(path, bytes.slice(0))
  }

  async replaceIfUnchanged(
    path: string,
    expectedBytes: ArrayBuffer | null,
    replacementBytes: ArrayBuffer | null,
    _isText: boolean,
  ): Promise<boolean> {
    const current = this.files.get(path) ?? null
    if (!sameOptionalBytes(current, expectedBytes)) return false
    if (replacementBytes === null) this.files.delete(path)
    else await this.write(path, replacementBytes)
    return true
  }

  async rename(from: string, to: string): Promise<void> {
    if (from === to) return
    const bytes = this.files.get(from)
    if (!bytes) {
      if (this.files.has(to)) return
      throw new Error(`Missing ${from}`)
    }
    if (this.files.has(to)) throw new Error(`Rename target already exists: ${to}`)
    this.files.set(to, bytes)
    this.files.delete(from)
  }

  async renameIfUnchanged(from: string, to: string, expectedBytes: ArrayBuffer): Promise<boolean> {
    const current = this.files.get(from) ?? null
    if (!sameOptionalBytes(current, expectedBytes)) return false
    if (from !== to && this.files.has(to)) return false
    await this.rename(from, to)
    return true
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path)
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path)
  }

  text(path: string): string | null {
    const bytes = this.files.get(path)
    return bytes ? new TextDecoder().decode(bytes) : null
  }
}

function sameOptionalBytes(left: ArrayBuffer | null, right: ArrayBuffer | null): boolean {
  if (left === null || right === null) return left === right
  if (left.byteLength !== right.byteLength) return false
  const leftBytes = new Uint8Array(left)
  const rightBytes = new Uint8Array(right)
  return leftBytes.every((byte, index) => byte === rightBytes[index])
}

export interface FakeEnvelope {
  operationId: string
  revisionId: string
  fileId?: string
  action: "upsert" | "delete" | "restore"
  path: string
  previousPath: string | null
  parents: string[]
  authorDeviceId: string
  blobId: string | null
  isText: boolean
  createdAt?: number
}

export class FakeCrypto implements CryptoPort {
  async verifyOperationLogLink(
    _device: DeviceKeyMaterial,
    _operation: RemoteOperation,
    _previousHash: string,
    _logFormat: LogFormat,
  ): Promise<void> {}

  async inspectRevision(
    _device: DeviceKeyMaterial,
    operation: RemoteOperation,
  ): Promise<HistoryRevisionMetadata> {
    const envelope = operation.envelope as FakeEnvelope
    return {
      revisionId: envelope.revisionId,
      operationId: envelope.operationId,
      fileId: envelope.fileId ?? envelope.path,
      action: envelope.action,
      path: envelope.path,
      previousPath: envelope.previousPath,
      parents: envelope.parents,
      authorDeviceId: envelope.authorDeviceId,
      createdAt: envelope.createdAt ?? operation.cursor,
      byteLength: envelope.blobId ? (this.historyBlobSizes.get(envelope.blobId) ?? 0) : 0,
      isText: envelope.isText,
    }
  }

  readonly historyBlobSizes = new Map<string, number>()

  async refreshTrustedCheckpoint(
    device: DeviceKeyMaterial,
    checkpoint: TrustedCheckpoint,
  ): Promise<DeviceKeyMaterial> {
    return { ...device, trustedCheckpoint: checkpoint, trustedCheckpointAuthorized: true }
  }

  async createRetentionAcknowledgement(
    device: DeviceKeyMaterial,
    checkpoint: TrustedCheckpoint,
  ): Promise<RetentionAcknowledgement> {
    return {
      deviceId: device.deviceId,
      cursor: checkpoint.cursor,
      logHash: checkpoint.logHash,
      epochId: device.epochId,
      historyRetention: "forever",
      signature: `ack-${checkpoint.cursor}`,
    }
  }

  async createFirstDevice(vaultId: string): Promise<SetupClaim> {
    return {
      vaultId,
      deviceId: TEST_DEVICE.deviceId,
      recoveryCode: "recovery",
      keyBundle: TEST_DEVICE.serialized,
      publicClaim: {},
    }
  }

  async loadDevice(): Promise<DeviceKeyMaterial> {
    return TEST_DEVICE
  }

  async signChallenge(
    _device: DeviceKeyMaterial,
    challenge: { challengeId: string; challenge: string },
  ): Promise<AuthChallengeProof> {
    return {
      challengeId: challenge.challengeId,
      deviceId: TEST_DEVICE.deviceId,
      signature: "signature",
    }
  }

  async recoverDevice(): Promise<{
    vaultId: string
    deviceId: string
    keyBundle: string
    publicClaim: unknown
  }> {
    return {
      vaultId: TEST_DEVICE.vaultId,
      deviceId: TEST_DEVICE.deviceId,
      keyBundle: TEST_DEVICE.serialized,
      publicClaim: {},
    }
  }

  async encryptRevision(
    device: DeviceKeyMaterial,
    draft: RevisionDraft,
  ): Promise<EncryptedRevision> {
    const blobId = draft.bytes ? `blob-${draft.revisionId}` : null
    const envelope: FakeEnvelope = {
      operationId: draft.operationId,
      revisionId: draft.revisionId,
      fileId: draft.fileId,
      action: draft.action,
      path: draft.path,
      previousPath: draft.previousPath,
      parents: draft.parents,
      authorDeviceId: device.deviceId,
      blobId,
      isText: draft.path.endsWith(".md"),
      createdAt: Date.now(),
    }
    return {
      envelope,
      blobs: draft.bytes ? [{ blobId: blobId ?? "", bytes: draft.bytes, chunkIndex: 0 }] : [],
    }
  }

  async decryptRevision(
    _device: DeviceKeyMaterial,
    operation: RemoteOperation,
    _maximumPlaintextBytes: number,
    loadBlob: (blobId: string) => Promise<ArrayBuffer>,
    onBlobProgress?: (progress: BlobTransferProgress) => void,
  ): Promise<DecryptedRevision> {
    const envelope = operation.envelope as FakeEnvelope
    const bytes = envelope.blobId ? await loadBlob(envelope.blobId) : null
    if (bytes) {
      onBlobProgress?.({
        completedChunks: 1,
        totalChunks: 1,
        transferredBytes: bytes.byteLength,
        totalBytes: bytes.byteLength,
      })
    }
    return {
      revisionId: envelope.revisionId,
      operationId: envelope.operationId,
      fileId: envelope.fileId ?? envelope.path,
      action: envelope.action,
      path: envelope.path,
      previousPath: envelope.previousPath,
      parents: envelope.parents,
      authorDeviceId: envelope.authorDeviceId,
      createdAt: envelope.createdAt ?? Date.now(),
      bytes,
      isText: envelope.isText,
    }
  }

  async createDeviceRevocation(
    _device: DeviceKeyMaterial,
    target: RemoteDevice,
  ): Promise<DeviceRevocationMaterial> {
    return {
      targetDeviceId: target.deviceId,
      operationId: "revocation-operation",
      envelope: {
        operationId: "revocation-operation",
        authorDeviceId: TEST_DEVICE.deviceId,
        type: "device-revocation",
        subjectDeviceId: target.deviceId,
      },
    }
  }

  async verifyDeviceRevocation(
    _device: DeviceKeyMaterial,
    operation: RemoteOperation,
  ): Promise<DeviceRevocationRecord> {
    const envelope = operation.envelope as { operationId: string; subjectDeviceId: string }
    return {
      deviceId: envelope.subjectDeviceId,
      operationId: envelope.operationId,
      cursor: operation.cursor,
    }
  }

  async createEpochTransition(device: DeviceKeyMaterial): Promise<EpochTransitionMaterial> {
    return {
      operationId: "epoch-transition",
      nextEpochId: `epoch-${device.epochSequence + 1}`,
      envelope: {
        operationId: "epoch-transition",
        authorDeviceId: device.deviceId,
        epochId: device.epochId,
        type: "key-epoch",
      },
    }
  }

  async applyEpochTransition(
    device: DeviceKeyMaterial,
    operation: RemoteOperation,
    predecessor: TrustedCheckpoint,
  ): Promise<DeviceKeyMaterial> {
    const sequence = device.epochSequence + 1
    return {
      ...device,
      serialized: `${device.serialized}-epoch-${sequence}`,
      epochId: `epoch-${sequence}`,
      epochSequence: sequence,
      epochActivatedAtCursor: operation.cursor,
      requiredTransitionOperationId: null,
      trustedCheckpoint: {
        ...predecessor,
        cursor: operation.cursor,
        logHash: operation.logHash,
      },
    }
  }

  async verifyLogFormatUpgrade(): Promise<"canonical-cbor-v1"> {
    return "canonical-cbor-v1"
  }

  async createPairingJoin(_pairing: PairingCapability): Promise<PairingJoinMaterial> {
    throw new Error("Not implemented by fake")
  }

  async approvePairing(): Promise<PairingApprovalMaterial> {
    throw new Error("Not implemented by fake")
  }

  async inspectPairingVerification(): Promise<PairingVerificationMaterial> {
    throw new Error("Not implemented by fake")
  }

  async createPairingConfirmation(): Promise<PairingConfirmationMaterial> {
    throw new Error("Not implemented by fake")
  }

  async verifyPairingConfirmation(): Promise<boolean> {
    throw new Error("Not implemented by fake")
  }

  async consumePairingResult(): Promise<PairedDeviceMaterial> {
    throw new Error("Not implemented by fake")
  }
}

export class FakeRemote implements RemotePort {
  readonly blobs = new Map<string, ArrayBuffer>()
  readonly operations: RemoteOperation[] = []
  authenticateCount = 0
  getChangesCount = 0
  readonly retentionAcknowledgements: RetentionAcknowledgement[] = []
  private cursor = 0
  private nextChangesBarrier: { started: () => void; resume: Promise<void> } | null = null
  private nextBlobUploadBarrier: { started: () => void; resume: Promise<void> } | null = null

  async claim(_setupSession: string, _claim: SetupClaim): Promise<void> {}

  async getRecoveryPackage(): Promise<RecoveryPackageMaterial> {
    return { encryptedRecoveryPackage: "recovery-package", recoveryStateId: "recovery-state" }
  }

  async authenticate(_device: DeviceKeyMaterial, _signer: CryptoPort): Promise<void> {
    this.authenticateCount += 1
  }

  async getChanges(after: number, _checkpoint: TrustedCheckpoint | null): Promise<RemoteChanges> {
    this.getChangesCount += 1
    const result = {
      operations: this.operations.filter((operation) => operation.cursor > after),
      latestCursor: this.cursor,
    }
    const barrier = this.nextChangesBarrier
    this.nextChangesBarrier = null
    barrier?.started()
    await barrier?.resume
    return result
  }

  blockNextChangesAfterRead(): { started: Promise<void>; release: () => void } {
    let markStarted = () => {}
    let release = () => {}
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const resume = new Promise<void>((resolve) => {
      release = resolve
    })
    this.nextChangesBarrier = { started: markStarted, resume }
    return { started, release }
  }

  blockNextBlobUploadAfterWrite(): { started: Promise<void>; release: () => void } {
    let markStarted = () => {}
    let release = () => {}
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const resume = new Promise<void>((resolve) => {
      release = resolve
    })
    this.nextBlobUploadBarrier = { started: markStarted, resume }
    return { started, release }
  }

  async putBlob(blob: EncryptedBlob): Promise<void> {
    this.blobs.set(blob.blobId, blob.bytes.slice(0))
    const barrier = this.nextBlobUploadBarrier
    this.nextBlobUploadBarrier = null
    barrier?.started()
    await barrier?.resume
  }

  async getStorageUsage(): Promise<RemoteStorageUsage> {
    const blobBytes = [...this.blobs.values()].reduce((total, bytes) => total + bytes.byteLength, 0)
    return {
      totalBytes: blobBytes,
      blobBytes,
      databaseBytes: 0,
      blobCount: this.blobs.size,
      reservedBlobBytes: 0,
      operationCount: this.operations.length,
      checkpointCount: 0,
      snapshotCount: 0,
      retentionMode: "forever",
      activeDeviceCount: 1,
      acknowledgedDeviceCount: this.retentionAcknowledgements.length > 0 ? 1 : 0,
      minimumAcknowledgedCursor: this.retentionAcknowledgements.at(-1)?.cursor ?? null,
      pruningAvailable: true,
    }
  }

  async acknowledgeRetention(acknowledgement: RetentionAcknowledgement): Promise<void> {
    this.retentionAcknowledgements.push(structuredClone(acknowledgement))
  }

  async pruneStorage(): Promise<StoragePruneResult> {
    return { deletedBytes: 0, deletedCount: 0, graceDays: 7 }
  }

  async getBlob(blobId: string): Promise<ArrayBuffer> {
    const bytes = this.blobs.get(blobId)
    if (!bytes) throw new Error(`Missing blob ${blobId}`)
    return bytes.slice(0)
  }

  async commit(envelope: unknown): Promise<{ cursor: number; logHash: string }> {
    this.cursor += 1
    const operation = {
      cursor: this.cursor,
      logHash: `hash-${this.cursor}`,
      envelope: fakeWorkerEnvelope(envelope),
    }
    this.operations.push(operation)
    return { cursor: operation.cursor, logHash: operation.logHash }
  }

  async listDevices(): Promise<RemoteDevice[]> {
    return []
  }

  async updateDeviceDescriptor(): Promise<void> {}

  async revokeDevice(
    _targetDeviceId: string,
    envelope: unknown,
  ): Promise<{ cursor: number; logHash: string }> {
    return this.commit(envelope)
  }

  async isDeviceAuthorized(): Promise<boolean> {
    return true
  }

  async createPairing(): Promise<PairingCapability> {
    throw new Error("Not implemented by fake")
  }

  async getPairingStatus(): Promise<PairingStatus> {
    throw new Error("Not implemented by fake")
  }

  async getPairingProgress(): Promise<PairingStatus> {
    throw new Error("Not implemented by fake")
  }

  async joinPairing(): Promise<PairingResult> {
    throw new Error("Not implemented by fake")
  }

  async approvePairing(): Promise<PairingResult> {
    throw new Error("Not implemented by fake")
  }

  async releasePairing(): Promise<PairingResult> {
    throw new Error("Not implemented by fake")
  }

  async getPairingResult(): Promise<PairingResult> {
    throw new Error("Not implemented by fake")
  }

  async confirmPairingOwner(): Promise<PairingResult> {
    throw new Error("Not implemented by fake")
  }

  async confirmPairingCandidate(): Promise<PairingResult> {
    throw new Error("Not implemented by fake")
  }

  async completePairing(): Promise<PairingResult> {
    throw new Error("Not implemented by fake")
  }

  async cancelPairing(): Promise<PairingResult> {
    throw new Error("Not implemented by fake")
  }

  async rejectPairing(): Promise<PairingResult> {
    throw new Error("Not implemented by fake")
  }

  connectNotifications(
    _after: number,
    _onCursor: (cursor: number) => void,
    onState: (connected: boolean) => void,
  ): () => void {
    onState(true)
    return () => onState(false)
  }

  addLogFormatTransition(): void {
    const previousCursor = this.cursor
    this.cursor += 1
    this.operations.push({
      cursor: this.cursor,
      logHash: `hash-${this.cursor}`,
      envelope: {
        type: "log-format-transition",
        operationId: `transition-${this.cursor}`,
        authorDeviceId: TEST_DEVICE.deviceId,
        previousHash: previousCursor === 0 ? "hash-0" : `hash-${previousCursor}`,
      },
    })
  }

  addRemoteRevision(envelope: FakeEnvelope, bytes: ArrayBuffer | null): void {
    if (envelope.blobId && bytes) this.blobs.set(envelope.blobId, bytes.slice(0))
    this.cursor += 1
    this.operations.push({
      cursor: this.cursor,
      logHash: `hash-${this.cursor}`,
      envelope: fakeWorkerEnvelope(envelope),
    })
  }
}

function fakeWorkerEnvelope(envelope: unknown): unknown {
  if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) return envelope
  const value = envelope as Record<string, unknown>
  if (typeof value.type === "string" || typeof value.action !== "string") return envelope
  const type =
    value.action === "delete" ? "tombstone" : value.action === "restore" ? "restore" : "revision"
  return { ...value, type }
}

export const ALL_CATEGORIES: Record<ConfigCategory, boolean> = {
  main: true,
  appearance: true,
  themes: true,
  hotkeys: true,
  "core-plugins": true,
  "core-plugin-settings": true,
}
