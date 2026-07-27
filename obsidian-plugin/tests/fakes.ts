import type {
  AuthChallengeProof,
  ConfigCategory,
  CryptoPort,
  DecryptedRevision,
  DeviceKeyMaterial,
  DeviceRevocationMaterial,
  DeviceRevocationRecord,
  EncryptedBlob,
  EncryptedRevision,
  PairedDeviceMaterial,
  ScannedFileSnapshot,
  PairingApprovalMaterial,
  PairingCapability,
  PairingConfirmationMaterial,
  PairingJoinMaterial,
  PairingResult,
  PairingStatus,
  PairingVerificationMaterial,
  RemoteChanges,
  RemoteDevice,
  RemoteOperation,
  RemotePort,
  RevisionDraft,
  SetupClaim,
  TrustedCheckpoint,
  VaultPort,
} from "../src/model"
import { fingerprint } from "../src/platform/bytes"
import { isConfigPath, isSyncablePath } from "../src/vault/path-policy"

export const TEST_DEVICE: DeviceKeyMaterial = {
  vaultId: "vault-1",
  deviceId: "device-local",
  serialized: "secret",
  trustedCheckpoint: { cursor: 0, logHash: "hash-0" },
}

export class FakeVault implements VaultPort {
  readonly files = new Map<string, ArrayBuffer>()
  readonly configDir = ".config"

  constructor(initial: Record<string, string> = {}) {
    for (const [path, value] of Object.entries(initial)) {
      this.files.set(path, new TextEncoder().encode(value).buffer)
    }
  }

  async listFiles(categories: Record<ConfigCategory, boolean>): Promise<ScannedFileSnapshot[]> {
    const snapshots: ScannedFileSnapshot[] = []
    for (const [path, bytes] of this.files) {
      if (!isSyncablePath(path, this.configDir, categories)) continue
      snapshots.push({
        path,
        fingerprint: await fingerprint(bytes),
        size: bytes.byteLength,
        mtime: 1,
        kind: isConfigPath(path, this.configDir) ? "config" : "vault",
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
    this.files.set(path, bytes.slice(0))
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
    loadBlob: (blobId: string) => Promise<ArrayBuffer>,
  ): Promise<DecryptedRevision> {
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
      createdAt: envelope.createdAt ?? Date.now(),
      bytes: envelope.blobId ? await loadBlob(envelope.blobId) : null,
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
  private cursor = 0
  private nextChangesBarrier: { started: () => void; resume: Promise<void> } | null = null

  async claim(_setupSession: string, _claim: SetupClaim): Promise<void> {}

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

  async putBlob(blob: EncryptedBlob): Promise<void> {
    this.blobs.set(blob.blobId, blob.bytes.slice(0))
  }

  async getBlob(blobId: string): Promise<ArrayBuffer> {
    const bytes = this.blobs.get(blobId)
    if (!bytes) throw new Error(`Missing blob ${blobId}`)
    return bytes.slice(0)
  }

  async commit(envelope: unknown): Promise<{ cursor: number; logHash: string }> {
    this.cursor += 1
    const operation = { cursor: this.cursor, logHash: `hash-${this.cursor}`, envelope }
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

  addRemoteRevision(envelope: FakeEnvelope, bytes: ArrayBuffer | null): void {
    if (envelope.blobId && bytes) this.blobs.set(envelope.blobId, bytes.slice(0))
    this.cursor += 1
    this.operations.push({
      cursor: this.cursor,
      logHash: `hash-${this.cursor}`,
      envelope,
    })
  }
}

export const ALL_CATEGORIES: Record<ConfigCategory, boolean> = {
  main: true,
  appearance: true,
  themes: true,
  hotkeys: true,
  "core-plugins": true,
  "core-plugin-settings": true,
}
