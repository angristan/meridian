export const CONFIG_CATEGORIES = [
  "main",
  "appearance",
  "themes",
  "hotkeys",
  "core-plugins",
  "core-plugin-settings",
] as const

export type ConfigCategory = (typeof CONFIG_CATEGORIES)[number]

export interface PendingDeviceRemoval {
  endpoint: string
  vaultId: string
  deviceId: string
  envelope: unknown
}

export interface PendingEpochTransition {
  endpoint: string
  vaultId: string
  deviceId: string
  operationId: string
  nextEpochId: string
  envelope: unknown
}

export interface PendingPairingCompletion {
  endpoint: string
  pairingId: string
  vaultId: string
  deviceId: string
  expiresAt: number
}

export interface SelectiveSyncSettings {
  excludedFolders: string[]
  excludedExtensions: string[]
}

export interface MeridianSettings {
  enabled: boolean
  endpoint: string
  vaultId: string
  deviceId: string
  deviceName: string
  pendingDeviceRemoval: PendingDeviceRemoval | null
  pendingPairingCompletion: PendingPairingCompletion | null
  pendingEpochTransition: PendingEpochTransition | null
  pollIntervalSeconds: number
  scanIntervalMinutes: number
  maxFileSizeMiB: number
  selectiveSync: SelectiveSyncSettings
  configCategories: Record<ConfigCategory, boolean>
}

export const DEFAULT_SETTINGS: MeridianSettings = {
  enabled: true,
  endpoint: "",
  vaultId: "",
  deviceId: "",
  deviceName: "",
  pendingDeviceRemoval: null,
  pendingPairingCompletion: null,
  pendingEpochTransition: null,
  pollIntervalSeconds: 45,
  scanIntervalMinutes: 5,
  maxFileSizeMiB: 64,
  selectiveSync: {
    excludedFolders: [],
    excludedExtensions: [],
  },
  configCategories: {
    main: true,
    appearance: true,
    themes: true,
    hotkeys: true,
    "core-plugins": true,
    "core-plugin-settings": true,
  },
}

export type SyncReason =
  | "startup"
  | "resume"
  | "file-event"
  | "interval"
  | "notification"
  | "manual"
  | "device-revocation"

export type SyncPhase =
  | "disconnected"
  | "idle"
  | "scanning"
  | "pulling"
  | "pushing"
  | "pausing"
  | "offline"
  | "error"

export interface PullSyncProgress {
  kind: "pull"
  startCursor: number
  currentCursor: number
  targetCursor: number
  currentChunk: number | null
  totalChunks: number | null
  transferredBytes: number
  totalBytes: number | null
}

export interface ScanSyncProgress {
  kind: "scan"
  processed: number
  total: number
  currentPath: string | null
}

export interface PushSyncProgress {
  kind: "push"
  processed: number
  succeeded: number
  failed: number
  total: number
  currentPath: string | null
  stage: "encrypting" | "uploading" | "committing" | null
  currentChunk: number | null
  totalChunks: number | null
  transferredBytes: number
  totalBytes: number | null
  currentCursor: number
}

export type SyncProgress = ScanSyncProgress | PullSyncProgress | PushSyncProgress

export interface SyncStatus {
  phase: SyncPhase
  message: string
  cursor: number
  queued: number
  lastSyncedAt: number | null
  socketConnected: boolean
  error: string | null
  progress: SyncProgress | null
}

export const INITIAL_STATUS: SyncStatus = {
  phase: "disconnected",
  message: "Connect Meridian to begin syncing",
  cursor: 0,
  queued: 0,
  lastSyncedAt: null,
  socketConnected: false,
  error: null,
  progress: null,
}

export interface ScannedFileSnapshot {
  path: string
  fingerprint: string
  size: number
  mtime: number
  kind: "vault" | "config"
}

export interface FileSnapshot extends ScannedFileSnapshot {
  /** Stable random identity preserved across edits, tombstones, and detected renames. */
  fileId: string
}

export interface DirtyPath {
  path: string
  token: string
  observedAt: number
}

export type JournalAction = "upsert" | "delete" | "restore"
export type JournalState = "queued" | "uploading" | "committing" | "complete" | "failed"

export interface JournalEntry {
  id: string
  action: JournalAction
  fileId: string
  path: string
  previousPath: string | null
  fingerprint: string | null
  baseRevisionId: string | null
  parentRevisionIds: string[]
  restoreSourceRevisionId: string | null
  revisionId: string
  createdAt: number
  attempts: number
  state: JournalState
  error: string | null
  preparedRevision: PreparedJournalRevision | null
}

export interface LocalRevision {
  revisionId: string
  fileId: string
  path: string
  /** Added after the initial journal schema; absent records are treated as upserts or deletes. */
  action?: JournalAction
  /** Previous normalized path for a rename, when recorded by the author. */
  previousPath?: string | null
  parents: string[]
  deviceId: string
  createdAt: number
  cursor: number | null
  tombstone: boolean
  isConflict: boolean
  /** Encrypted signed operation retained locally so immutable history can be restored. */
  operation: RemoteOperation | null
}

export type SyncActivityKind =
  | "created"
  | "modified"
  | "renamed"
  | "deleted"
  | "restored"
  | "conflict"

export interface RevisionPreview {
  revision: LocalRevision
  kind: "deleted" | "text" | "binary"
  byteLength: number
  text: string | null
  truncated: boolean
}

export interface RevisionDiffLine {
  kind: "context" | "added" | "removed"
  text: string
}

export interface RevisionComparison {
  path: string
  lines: RevisionDiffLine[]
  truncated: boolean
  unavailableReason: string | null
}

export interface RetentionAcknowledgement {
  deviceId: string
  cursor: number
  logHash: string
  epochId: string
  historyRetention: "forever"
  signature: string
}

export interface RemoteStorageUsage {
  totalBytes: number
  blobBytes: number
  databaseBytes: number
  blobCount: number
  reservedBlobBytes: number
  operationCount: number
  checkpointCount: number
  snapshotCount: number
  retentionMode: "forever"
  activeDeviceCount: number
  acknowledgedDeviceCount: number
  minimumAcknowledgedCursor: number | null
  pruningAvailable: boolean
}

export type LocalStoragePressure = "unavailable" | "normal" | "warning" | "critical"

export interface LocalStorageUsage {
  usageBytes: number | null
  quotaBytes: number | null
  persisted: boolean | null
  pressure: LocalStoragePressure
}

export interface StorageUsage extends RemoteStorageUsage {
  local: LocalStorageUsage
}

export interface LocalCompactionResult {
  completedEntries: number
  duplicateHistoryRevisions: number
}

export interface StoragePruneResult {
  deletedBytes: number
  deletedCount: number
  graceDays: number
}

export interface SyncDiagnostic {
  timestamp: number
  phase: SyncPhase
  message: string
  error: string | null
}

export interface SyncActivity {
  revisionId: string
  fileId: string
  kind: SyncActivityKind
  path: string
  previousPath: string | null
  deviceId: string
  createdAt: number
  cursor: number | null
  local: boolean
}

export interface DeletedFileRecord {
  fileId: string
  path: string
  deletedRevisionId: string
  deletedAt: number
  deviceId: string
  recoverableRevisionId: string | null
}

export interface ConflictRecord {
  id: string
  sourcePath: string
  conflictPath: string
  localRevisionId: string | null
  remoteRevisionId: string
  createdAt: number
  kind: "text" | "binary" | "config"
  resolvedAt: number | null
}

export type ConflictResolutionAction = "keep-current" | "use-incoming" | "keep-both"

export interface ConflictFilePreview {
  kind: "missing" | "text" | "binary"
  byteLength: number
  text: string | null
  truncated: boolean
}

export interface ConflictDetails {
  conflict: ConflictRecord
  incomingDeleted: boolean
  current: ConflictFilePreview
  preserved: ConflictFilePreview
  comparison: RevisionComparison
}

export type LogFormat = "legacy-http-v1" | "canonical-cbor-v1"

export interface TrustedCheckpoint {
  cursor: number
  logHash: string
  /** Missing values are migrated as the deployed legacy format. */
  initialLogFormat?: LogFormat
  /** Format used to verify the operation after this checkpoint. */
  logFormat?: LogFormat
}

export interface SetupClaim {
  vaultId: string
  deviceId: string
  recoveryCode: string
  keyBundle: string
  publicClaim: unknown
}

export interface DeviceKeyMaterial {
  vaultId: string
  deviceId: string
  serialized: string
  epochId: string
  epochSequence: number
  epochActivatedAtCursor: number
  requiredTransitionOperationId: string | null
  trustedCheckpoint: TrustedCheckpoint
  trustedCheckpointAuthorized: boolean
}

export interface RecoveryPackageMaterial {
  encryptedRecoveryPackage: string
  recoveryStateId: string
}

export interface RecoveryDeviceMaterial {
  vaultId: string
  deviceId: string
  keyBundle: string
  publicClaim: unknown
}

export interface RevisionDraft {
  operationId: string
  revisionId: string
  fileId: string
  action: JournalAction
  path: string
  previousPath: string | null
  parents: string[]
  bytes: ArrayBuffer | null
  chunkSize: number
}

export interface EncryptedBlob {
  blobId: string
  bytes: ArrayBuffer
  chunkIndex: number
}

export interface EncryptedRevision {
  blobs: EncryptedBlob[]
  envelope: unknown
}

export interface PreparedJournalRevision {
  action: JournalAction
  bytes: ArrayBuffer | null
  encrypted: EncryptedRevision
  /** Missing on payloads created before the signed operation ID was bound to the journal entry. */
  operationIdBound?: true
  invalidatedByEpoch?: true
}

export interface BlobTransferProgress {
  completedChunks: number
  totalChunks: number
  transferredBytes: number
  totalBytes: number
}

export interface RemoteOperation {
  cursor: number
  logHash: string
  envelope: unknown
  authorCertificate?: string
  certificateChain?: string[]
}

export interface DeviceRevocationRecord {
  deviceId: string
  operationId: string
  cursor: number
}

export interface DeviceRevocationMaterial {
  targetDeviceId: string
  operationId: string
  envelope: unknown
}

export interface EpochTransitionMaterial {
  operationId: string
  nextEpochId: string
  envelope: unknown
}

export interface HistoryRevisionMetadata {
  revisionId: string
  operationId: string
  fileId: string
  action: JournalAction
  path: string
  previousPath: string | null
  parents: string[]
  authorDeviceId: string
  createdAt: number
  byteLength: number
  isText: boolean
}

export interface DecryptedRevision {
  revisionId: string
  operationId: string
  fileId: string
  action: JournalAction
  path: string
  previousPath: string | null
  parents: string[]
  authorDeviceId: string
  createdAt: number
  bytes: ArrayBuffer | null
  isText: boolean
}

export interface AuthChallengeProof {
  challengeId: string
  deviceId: string
  signature: string
}

export interface PairingDeviceDescriptor {
  deviceName: string
  platform: string
}

export interface PairingJoinMaterial {
  payload: unknown
  candidatePackage: string
  pendingSecret: string
}

export interface PairingApprovalMaterial {
  payload: unknown
  releasePayload: unknown
  verificationPhrase: string
  transferHash: string
}

export interface PairingVerificationMaterial {
  verificationPhrase: string
  transferHash: string
}

export interface PairingConfirmationMaterial {
  transferHash: string
  proof: string
}

export interface PairedDeviceMaterial {
  vaultId: string
  deviceId: string
  keyBundle: string
  completion: PairingConfirmationMaterial
}

export interface CryptoPort {
  createFirstDevice(setupSession: string, claimChallenge: string): Promise<SetupClaim>
  verifyOperationLogLink(
    device: DeviceKeyMaterial,
    operation: RemoteOperation,
    previousHash: string,
    logFormat: LogFormat,
  ): Promise<void>
  inspectRevision(
    device: DeviceKeyMaterial,
    operation: RemoteOperation,
    maximumPlaintextBytes: number,
  ): Promise<HistoryRevisionMetadata>
  refreshTrustedCheckpoint(
    device: DeviceKeyMaterial,
    checkpoint: TrustedCheckpoint,
  ): Promise<DeviceKeyMaterial>
  createRetentionAcknowledgement(
    device: DeviceKeyMaterial,
    checkpoint: TrustedCheckpoint,
  ): Promise<RetentionAcknowledgement>
  loadDevice(serializedKeyBundle: string): Promise<DeviceKeyMaterial>
  signChallenge(
    device: DeviceKeyMaterial,
    challenge: { challengeId: string; challenge: string },
  ): Promise<AuthChallengeProof>
  recoverDevice(
    recoveryCode: string,
    encryptedRecoveryPackage: string,
    recoveryStateId: string,
    challenge: { challengeId: string; challenge: string },
  ): Promise<RecoveryDeviceMaterial>
  encryptRevision(device: DeviceKeyMaterial, draft: RevisionDraft): Promise<EncryptedRevision>
  decryptRevision(
    device: DeviceKeyMaterial,
    operation: RemoteOperation,
    maximumPlaintextBytes: number,
    loadBlob: (blobId: string) => Promise<ArrayBuffer>,
    onBlobProgress?: (progress: BlobTransferProgress) => void,
  ): Promise<DecryptedRevision>
  createDeviceRevocation(
    device: DeviceKeyMaterial,
    target: RemoteDevice,
  ): Promise<DeviceRevocationMaterial>
  verifyDeviceRevocation(
    device: DeviceKeyMaterial,
    operation: RemoteOperation,
  ): Promise<DeviceRevocationRecord>
  verifyLogFormatUpgrade(
    device: DeviceKeyMaterial,
    operation: RemoteOperation,
  ): Promise<"canonical-cbor-v1">
  createEpochTransition(
    device: DeviceKeyMaterial,
    recipients: RemoteDevice[],
    recoveryStateId: string,
    reason: "scheduled" | "revocation" | "migration",
  ): Promise<EpochTransitionMaterial>
  applyEpochTransition(
    device: DeviceKeyMaterial,
    operation: RemoteOperation,
    predecessor: TrustedCheckpoint,
  ): Promise<DeviceKeyMaterial>
  createPairingJoin(
    pairing: PairingCapability,
    descriptor: PairingDeviceDescriptor,
  ): Promise<PairingJoinMaterial>
  approvePairing(
    device: DeviceKeyMaterial,
    candidatePackage: string,
    certificates: string[],
  ): Promise<PairingApprovalMaterial>
  inspectPairingVerification(
    pendingSecret: string,
    verificationPreview: string,
  ): Promise<PairingVerificationMaterial>
  createPairingConfirmation(
    pendingSecret: string,
    transferHash: string,
  ): Promise<PairingConfirmationMaterial>
  verifyPairingConfirmation(
    candidatePackage: string,
    confirmation: PairingConfirmationMaterial,
  ): Promise<boolean>
  consumePairingResult(
    pendingSecret: string,
    hpkeTransfer: string,
    confirmedPhrase: string,
    expectedTransferHash: string,
  ): Promise<PairedDeviceMaterial>
}

export interface RemoteChanges {
  operations: RemoteOperation[]
  latestCursor: number
}

export interface RemoteDevice {
  deviceId: string
  signingPublicKey: string
  hpkePublicKey: string
  certificate: string
  role: "owner" | "member"
  authorizedAt: number
  revokedAt: number | null
  deviceName: string | null
  platform: string | null
}

export interface PairingCapability {
  pairingId: string
  capability: string
  vaultId: string
  expiresAt: number
}

export interface PairingInvitation extends PairingCapability {
  link: string
}

export type PairingState =
  | "pending"
  | "joined"
  | "verifying"
  | "confirmed"
  | "released"
  | "completed"
  | "canceled"

export interface PairingStatus {
  pairingId: string
  status: PairingState
  expiresAt: number
  requestedAt?: number
  ownerConfirmed: boolean
  candidateConfirmed: boolean
  candidateConfirmation?: PairingConfirmationMaterial
  candidatePackage?: string
  candidate?: PairingDeviceDescriptor & {
    deviceId: string
    signingPublicKey: string
    hpkePublicKey: string
  }
}

export interface PairingResult {
  pairingId: string
  status: PairingState
  deviceId?: string
  certificate?: string
  transcriptHash?: string
  verificationPreview?: string
  approvalSignature?: string
  hpkeTransfer?: string
  verificationStartedAt?: number
}

export interface RemotePort {
  claim(setupSession: string, claim: SetupClaim): Promise<void>
  getRecoveryPackage(): Promise<RecoveryPackageMaterial>
  authenticate(device: DeviceKeyMaterial, signer: CryptoPort): Promise<void>
  getChanges(after: number, checkpoint: TrustedCheckpoint | null): Promise<RemoteChanges>
  putBlob(blob: EncryptedBlob): Promise<void>
  getBlob(blobId: string): Promise<ArrayBuffer>
  getStorageUsage(): Promise<RemoteStorageUsage>
  acknowledgeRetention(acknowledgement: RetentionAcknowledgement): Promise<void>
  pruneStorage(): Promise<StoragePruneResult>
  commit(envelope: unknown, idempotencyKey: string): Promise<{ cursor: number; logHash: string }>
  listDevices(): Promise<RemoteDevice[]>
  updateDeviceDescriptor(descriptor: PairingDeviceDescriptor): Promise<void>
  revokeDevice(
    targetDeviceId: string,
    envelope: unknown,
  ): Promise<{ cursor: number; logHash: string }>
  isDeviceAuthorized(deviceId: string): Promise<boolean>
  createPairing(): Promise<PairingCapability>
  getPairingStatus(pairingId: string): Promise<PairingStatus>
  getPairingProgress(pairingId: string, capability: string): Promise<PairingStatus>
  joinPairing(pairingId: string, payload: unknown): Promise<PairingResult>
  approvePairing(pairingId: string, payload: unknown): Promise<PairingResult>
  releasePairing(pairingId: string, payload: unknown): Promise<PairingResult>
  getPairingResult(pairingId: string, capability: string): Promise<PairingResult>
  confirmPairingOwner(pairingId: string): Promise<PairingResult>
  confirmPairingCandidate(pairingId: string, payload: unknown): Promise<PairingResult>
  completePairing(pairingId: string, payload: unknown): Promise<PairingResult>
  cancelPairing(pairingId: string, capability: string): Promise<PairingResult>
  rejectPairing(pairingId: string): Promise<PairingResult>
  connectNotifications(
    after: number,
    onCursor: (cursor: number) => void,
    onState: (connected: boolean) => void,
  ): () => void
}

export interface VaultScanOptions {
  shouldStop?: () => boolean
  onProgress?: (progress: ScanSyncProgress) => void
  fingerprintCache?: ReadonlyMap<string, ScannedFileSnapshot>
  forceFingerprint?: boolean
}

export interface VaultPort {
  configDir: string
  maxFileBytes(): number
  close?(): void
  listFiles(
    categories: Record<ConfigCategory, boolean>,
    selection?: SelectiveSyncSettings,
    options?: VaultScanOptions,
  ): Promise<ScannedFileSnapshot[]>
  scanFiles(
    paths: readonly string[],
    categories: Record<ConfigCategory, boolean>,
    selection?: SelectiveSyncSettings,
    options?: VaultScanOptions,
  ): Promise<ScannedFileSnapshot[]>
  read(path: string): Promise<ArrayBuffer>
  write(path: string, bytes: ArrayBuffer): Promise<void>
  replaceIfUnchanged(
    path: string,
    expectedBytes: ArrayBuffer | null,
    replacementBytes: ArrayBuffer | null,
    isText: boolean,
  ): Promise<boolean>
  rename(from: string, to: string): Promise<void>
  renameIfUnchanged(from: string, to: string, expectedBytes: ArrayBuffer): Promise<boolean>
  remove(path: string): Promise<void>
  exists(path: string): Promise<boolean>
}
