export const CONFIG_CATEGORIES = [
  "main",
  "appearance",
  "themes",
  "hotkeys",
  "core-plugins",
  "core-plugin-settings",
] as const

export type ConfigCategory = (typeof CONFIG_CATEGORIES)[number]

export interface MeridianSettings {
  enabled: boolean
  endpoint: string
  vaultId: string
  deviceId: string
  deviceName: string
  pollIntervalSeconds: number
  scanIntervalMinutes: number
  maxFileSizeMiB: number
  configCategories: Record<ConfigCategory, boolean>
}

export const DEFAULT_SETTINGS: MeridianSettings = {
  enabled: true,
  endpoint: "",
  vaultId: "",
  deviceId: "",
  deviceName: "",
  pollIntervalSeconds: 45,
  scanIntervalMinutes: 5,
  maxFileSizeMiB: 64,
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

export type SyncPhase =
  | "disconnected"
  | "idle"
  | "scanning"
  | "pulling"
  | "pushing"
  | "offline"
  | "error"

export interface SyncStatus {
  phase: SyncPhase
  message: string
  cursor: number
  queued: number
  lastSyncedAt: number | null
  socketConnected: boolean
  error: string | null
}

export const INITIAL_STATUS: SyncStatus = {
  phase: "disconnected",
  message: "Connect Meridian to begin syncing",
  cursor: 0,
  queued: 0,
  lastSyncedAt: null,
  socketConnected: false,
  error: null,
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
}

export interface LocalRevision {
  revisionId: string
  fileId: string
  path: string
  parents: string[]
  deviceId: string
  createdAt: number
  cursor: number | null
  tombstone: boolean
  isConflict: boolean
  /** Encrypted signed operation retained locally so immutable history can be restored. */
  operation: RemoteOperation | null
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

export interface TrustedCheckpoint {
  cursor: number
  logHash: string
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
  trustedCheckpoint: TrustedCheckpoint
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

export interface RemoteOperation {
  cursor: number
  logHash: string
  envelope: unknown
  authorCertificate?: string
  certificateChain?: string[]
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

export interface PairingJoinMaterial {
  payload: unknown
  candidatePackage: string
  pendingSecret: string
}

export interface PairingApprovalMaterial {
  payload: unknown
  verificationPhrase: string
}

export interface PairedDeviceMaterial {
  vaultId: string
  deviceId: string
  keyBundle: string
}

export interface CryptoPort {
  createFirstDevice(setupSession: string, claimChallenge: string): Promise<SetupClaim>
  loadDevice(serializedKeyBundle: string): Promise<DeviceKeyMaterial>
  signChallenge(
    device: DeviceKeyMaterial,
    challenge: { challengeId: string; challenge: string },
  ): Promise<AuthChallengeProof>
  recoverDevice(
    recoveryCode: string,
    encryptedRecoveryPackage: string,
    challenge: { challengeId: string; challenge: string },
  ): Promise<RecoveryDeviceMaterial>
  encryptRevision(device: DeviceKeyMaterial, draft: RevisionDraft): Promise<EncryptedRevision>
  decryptRevision(
    device: DeviceKeyMaterial,
    operation: RemoteOperation,
    loadBlob: (blobId: string) => Promise<ArrayBuffer>,
  ): Promise<DecryptedRevision>
  createPairingJoin(pairing: PairingCapability): Promise<PairingJoinMaterial>
  approvePairing(
    device: DeviceKeyMaterial,
    candidatePackage: string,
    certificates: string[],
  ): Promise<PairingApprovalMaterial>
  consumePairingResult(
    pendingSecret: string,
    hpkeTransfer: string,
    confirmedPhrase: string,
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
}

export interface PairingCapability {
  pairingId: string
  capability: string
  vaultId: string
  expiresAt: number
}

export interface PairingResult {
  pairingId: string
  status: "pending" | "joined" | "approved"
  deviceId?: string
  certificate?: string
  transcriptHash?: string
  approvalSignature?: string
  hpkeTransfer?: string
  approvedAt?: number
}

export interface RemotePort {
  claim(setupSession: string, claim: SetupClaim): Promise<void>
  authenticate(device: DeviceKeyMaterial, signer: CryptoPort): Promise<void>
  getChanges(after: number, checkpoint: TrustedCheckpoint | null): Promise<RemoteChanges>
  putBlob(blob: EncryptedBlob): Promise<void>
  getBlob(blobId: string): Promise<ArrayBuffer>
  commit(envelope: unknown, idempotencyKey: string): Promise<{ cursor: number; logHash: string }>
  listDevices(): Promise<RemoteDevice[]>
  createPairing(): Promise<PairingCapability>
  joinPairing(pairingId: string, payload: unknown): Promise<PairingResult>
  approvePairing(pairingId: string, payload: unknown): Promise<PairingResult>
  getPairingResult(pairingId: string, capability: string): Promise<PairingResult>
  connectNotifications(
    after: number,
    onCursor: (cursor: number) => void,
    onState: (connected: boolean) => void,
  ): () => void
}

export interface VaultPort {
  configDir: string
  listFiles(categories: Record<ConfigCategory, boolean>): Promise<ScannedFileSnapshot[]>
  read(path: string): Promise<ArrayBuffer>
  write(path: string, bytes: ArrayBuffer): Promise<void>
  remove(path: string): Promise<void>
  exists(path: string): Promise<boolean>
}
