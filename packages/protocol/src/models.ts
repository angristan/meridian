import type {
  BlobId,
  CertificateId,
  DeviceId,
  Ed25519PublicKey,
  Ed25519Signature,
  EpochId,
  FileId,
  Hash,
  Nonce,
  OperationId,
  PairingId,
  RevisionId,
  VaultEpochKey,
  VaultId,
  WrappedRevisionKey,
  X25519PublicKey,
} from "./bytes.js"
import type { CipherSuite, LogFormat, OperationType, Permission } from "./constants.js"

export interface Signed<T> {
  readonly body: T
  readonly signature: Ed25519Signature
}

export interface DeviceCertificateBody {
  readonly certificateId: CertificateId
  readonly vaultId: VaultId
  readonly deviceId: DeviceId
  readonly signingPublicKey: Ed25519PublicKey
  readonly hpkePublicKey: X25519PublicKey
  readonly permissions: readonly Permission[]
  readonly issuer:
    | { readonly kind: "recovery" }
    | { readonly kind: "device"; readonly certificateId: CertificateId }
  readonly epochId: EpochId
  readonly suite: CipherSuite
  readonly validFromCursor: number
  readonly expiresAt: number | null
}

export type DeviceCertificate = Signed<DeviceCertificateBody>

export interface EpochDeclarationBody {
  readonly vaultId: VaultId
  readonly epochId: EpochId
  readonly sequence: number
  readonly previousEpochId: EpochId | null
  readonly suite: CipherSuite
  readonly createdBy: DeviceId | "recovery"
  readonly reason: "initial" | "scheduled" | "revocation" | "recovery" | "migration"
}

export type EpochDeclaration = Signed<EpochDeclarationBody>

export interface CheckpointBody {
  readonly vaultId: VaultId
  readonly epochId: EpochId
  readonly cursor: number
  readonly logHash: Hash
  readonly signerDeviceId: DeviceId
  readonly protocolGeneration: number
  /** Missing on legacy checkpoints, which always use the legacy format from cursor zero. */
  readonly initialLogFormat?: LogFormat
  /** Format used to verify the operation immediately after this checkpoint. */
  readonly logFormat?: LogFormat
}

export type SignedCheckpoint = Signed<CheckpointBody>

export interface ChunkAssociatedData {
  readonly protocolGeneration: number
  readonly suite: CipherSuite
  readonly vaultId: VaultId
  readonly epochId: EpochId
  readonly fileId: FileId
  readonly revisionId: RevisionId
  readonly operationType: OperationType
  readonly objectKind: "revision-metadata" | "content-chunk"
  readonly chunkIndex: number
  readonly chunkCount: number
}

export interface EncryptedChunk {
  readonly blobId: BlobId
  readonly chunkIndex: number
  readonly plaintextLength: number
  readonly nonce: Nonce
}

/** Metadata is encrypted separately; paths, parent IDs, tombstones, and manifests live inside it. */
export interface RevisionOperation {
  readonly type: "revision"
  readonly operationId: OperationId
  readonly vaultId: VaultId
  readonly epochId: EpochId
  readonly authorDeviceId: DeviceId
  readonly fileId: FileId
  readonly revisionId: RevisionId
  readonly wrappedRevisionKey: WrappedRevisionKey
  readonly metadataNonce: Nonce
  readonly encryptedMetadata: Uint8Array
  readonly chunks: readonly EncryptedChunk[]
  readonly suite: CipherSuite
}

export interface RevisionMetadata {
  readonly normalizedPath: string
  readonly parents: readonly RevisionId[]
  readonly tombstone: boolean
  readonly contentType: "binary" | "utf8-text"
  readonly totalPlaintextLength: number
  readonly createdAt: number
}

export interface DeviceRevocationOperation {
  readonly type: "device-revocation"
  readonly operationId: OperationId
  readonly vaultId: VaultId
  readonly epochId: EpochId
  readonly authorDeviceId: DeviceId | "recovery"
  readonly certificateId: CertificateId
  readonly reason: "lost" | "compromised" | "replaced" | "retired"
  readonly suite: CipherSuite
}

export interface EpochKeyPackage {
  readonly recipientDeviceId: DeviceId
  readonly transfer: HpkeTransfer
}

export interface EpochTransitionOperation {
  readonly type: "epoch-transition"
  readonly operationId: OperationId
  readonly vaultId: VaultId
  /** Epoch authorizing this transition. */
  readonly epochId: EpochId
  readonly authorDeviceId: DeviceId
  readonly previousCursor: number
  readonly previousLogHash: Hash
  readonly declaration: EpochDeclaration
  readonly keyPackages: readonly EpochKeyPackage[]
  readonly previousRecoveryStateId: Hash
  readonly encryptedRecoveryPackage: Uint8Array
  readonly suite: CipherSuite
}

/** Owner-authorized bridge from deployed legacy hashes to canonical generation-1 hashes. */
export interface LogFormatTransitionOperation {
  readonly type: "log-format-transition"
  readonly operationId: OperationId
  readonly vaultId: VaultId
  readonly epochId: EpochId
  readonly authorDeviceId: DeviceId
  readonly previousCursor: number
  readonly previousLogHash: Hash
  readonly nextLogFormat: "canonical-cbor-v1"
  readonly suite: CipherSuite
}

export type OperationBody =
  | RevisionOperation
  | DeviceRevocationOperation
  | EpochTransitionOperation
  | LogFormatTransitionOperation
export type SignedOperation = Signed<OperationBody>

export interface LogEntry {
  readonly cursor: number
  readonly previousHash: Hash
  readonly operation: SignedOperation
  readonly entryHash: Hash
}

export interface PairingDeviceMetadata {
  readonly deviceName: string
  readonly platform: string
}

export interface PairingContext {
  readonly pairingId: PairingId
  readonly vaultId: VaultId
  readonly newDeviceId: DeviceId
  readonly newDeviceSigningPublicKey: Ed25519PublicKey
  readonly newDeviceHpkePublicKey: X25519PublicKey
  readonly newDeviceName: string
  readonly newDevicePlatform: string
  readonly certificate: DeviceCertificate
  readonly authorizationChain: readonly DeviceCertificate[]
  readonly recoveryPublicKey: Ed25519PublicKey
  readonly epoch: EpochDeclaration
  readonly checkpoint: SignedCheckpoint
  readonly expiresAt: number
  readonly suite: CipherSuite
}

export interface HpkeTransfer {
  readonly encapsulatedKey: Uint8Array
  readonly ciphertext: Uint8Array
}

export interface SignedPairingTransfer {
  readonly context: PairingContext
  readonly transfer: HpkeTransfer
  readonly approverDeviceId: DeviceId
  readonly signature: Ed25519Signature
}

/** Signed transcript metadata safe to release before the encrypted transfer. */
export interface PairingVerificationPreview {
  readonly context: PairingContext
  readonly approverDeviceId: DeviceId
  readonly transferHash: Hash
  readonly signature: Ed25519Signature
}

export interface EpochKeyMaterial {
  readonly epochId: EpochId
  readonly vaultEpochKey: VaultEpochKey
}

export interface RecoveryState {
  readonly vaultId: VaultId
  readonly epoch: EpochDeclaration
  readonly vaultEpochKey: VaultEpochKey
  readonly epochKeys: readonly EpochKeyMaterial[]
  readonly checkpoint: SignedCheckpoint
  readonly recoverySequence: number
  /** Transition that must immediately follow the package checkpoint, for owner-updated packages. */
  readonly requiredTransitionOperationId?: OperationId
}

export interface LegacyEncryptedRecoveryPackage {
  readonly packageVersion?: 1
  readonly protocolGeneration: number
  readonly vaultId: VaultId
  readonly nonce: Nonce
  readonly ciphertext: Uint8Array
  readonly checkpoint: SignedCheckpoint
}

export interface PublicKeyEncryptedRecoveryPackage {
  readonly packageVersion: 2
  readonly protocolGeneration: number
  readonly vaultId: VaultId
  readonly encapsulatedKey: Uint8Array
  readonly ciphertext: Uint8Array
  readonly checkpoint: SignedCheckpoint
}

export type EncryptedRecoveryPackage =
  | LegacyEncryptedRecoveryPackage
  | PublicKeyEncryptedRecoveryPackage

export interface AuthChallenge {
  readonly challengeId: string
  readonly vaultId: VaultId
  readonly deviceId: DeviceId
  readonly challenge: Uint8Array
  readonly expiresAt: number
}
