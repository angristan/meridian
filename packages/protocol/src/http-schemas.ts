import * as Schema from "effect/Schema"

const NonEmptyString = Schema.String.pipe(Schema.check(Schema.isMinLength(1)))
const NonNegativeInteger = Schema.Number.pipe(
  Schema.check(Schema.isInt()),
  Schema.check(Schema.isGreaterThanOrEqualTo(0)),
)
const NullableString = Schema.NullOr(Schema.String)
const NullableNonNegativeInteger = Schema.NullOr(NonNegativeInteger)

export const DevicePublicIdentitySchema = Schema.Struct({
  deviceId: Schema.String,
  signingPublicKey: Schema.String,
  hpkePublicKey: Schema.String,
  certificate: Schema.String,
})

export type DevicePublicIdentity = typeof DevicePublicIdentitySchema.Type

export const DeviceDescriptorSchema = Schema.Struct({
  deviceName: Schema.String,
  platform: Schema.String,
})

export const SetupSessionRequestSchema = Schema.Struct({ token: Schema.String })

export const SetupClaimSchema = Schema.Struct({
  setupSession: Schema.String,
  vaultId: Schema.String,
  recoverySigningPublicKey: Schema.String,
  encryptedRecoveryPackage: Schema.String,
  logFormat: Schema.Literal("canonical-cbor-v1"),
  initialDevice: DevicePublicIdentitySchema,
  proof: Schema.String,
})

export type SetupClaim = typeof SetupClaimSchema.Type

export const AuthChallengeSchema = Schema.Struct({ deviceId: Schema.String })

export const AuthSessionSchema = Schema.Struct({
  deviceId: Schema.String,
  challengeId: Schema.String,
  signature: Schema.String,
})

export type AuthSession = typeof AuthSessionSchema.Type

export const RecoveryClaimSchema = Schema.Struct({
  claimVersion: Schema.Literal(2),
  recoveryId: Schema.String,
  previousRecoveryStateId: Schema.String,
  challengeId: Schema.String,
  newDevice: DevicePublicIdentitySchema,
  encryptedRecoveryPackage: Schema.String,
  proof: Schema.String,
})

export type RecoveryClaim = typeof RecoveryClaimSchema.Type

export const CreatePairingSchema = Schema.Struct({
  expiresInSeconds: Schema.optionalKey(Schema.Number),
})

export const PairingJoinSchema = Schema.Struct({
  capability: Schema.String,
  device: Schema.Struct({
    deviceId: Schema.String,
    signingPublicKey: Schema.String,
    hpkePublicKey: Schema.String,
    deviceName: Schema.String,
    platform: Schema.String,
  }),
  proof: Schema.String,
  requestProof: Schema.String,
})

export type PairingJoin = typeof PairingJoinSchema.Type

export const PairingApprovalSchema = Schema.Struct({
  certificate: Schema.String,
  transcriptHash: Schema.String,
  verificationPreview: Schema.String,
})

export type PairingApproval = typeof PairingApprovalSchema.Type

export const PairingReleaseSchema = Schema.Struct({
  approvalSignature: Schema.String,
  hpkeTransfer: Schema.String,
})

export type PairingRelease = typeof PairingReleaseSchema.Type

export const PairingResultSchema = Schema.Struct({ capability: Schema.String })

export const PairingCandidateConfirmationSchema = Schema.Struct({
  capability: Schema.String,
  transferHash: Schema.String,
  proof: Schema.String,
})

export type PairingCandidateConfirmation = typeof PairingCandidateConfirmationSchema.Type

export const PairingCancelSchema = Schema.Struct({ capability: Schema.String })

export const StoredOperationTypeSchema = Schema.Literals([
  "revision",
  "merge",
  "tombstone",
  "restore",
  "device-revocation",
  "key-epoch",
  "log-format-transition",
])

export const WritableOperationTypeSchema = Schema.Literals([
  "revision",
  "tombstone",
  "restore",
  "device-revocation",
  "key-epoch",
])

export const OperationSchema = Schema.Struct({
  operationId: Schema.String,
  authorDeviceId: Schema.String,
  epochId: Schema.String,
  type: WritableOperationTypeSchema,
  subjectDeviceId: Schema.optionalKey(Schema.String),
  envelope: Schema.String,
  signature: Schema.String,
})

export type Operation = typeof OperationSchema.Type

export const RevokeDeviceSchema = Schema.Struct({ operation: OperationSchema })

export const CheckpointSchema = Schema.Struct({
  checkpointId: Schema.String,
  cursor: Schema.Number,
  logHash: Schema.String,
  epochId: Schema.String,
  envelope: Schema.String,
  signature: Schema.String,
})

export type Checkpoint = typeof CheckpointSchema.Type

export const SnapshotSchema = Schema.Struct({
  snapshotId: Schema.String,
  cursor: Schema.Number,
  logHash: Schema.String,
  epochId: Schema.String,
  envelope: Schema.String,
  signature: Schema.String,
})

export type Snapshot = typeof SnapshotSchema.Type

export const RetentionAcknowledgementSchema = Schema.Struct({
  deviceId: Schema.String,
  cursor: Schema.Number,
  logHash: Schema.String,
  epochId: Schema.String,
  historyRetention: Schema.Literal("forever"),
  signature: Schema.String,
})

export type RetentionAcknowledgement = typeof RetentionAcknowledgementSchema.Type

export const EmptyObjectSchema = Schema.Struct({})

export const ErrorResponseSchema = Schema.Struct({
  error: Schema.Struct({
    code: NonEmptyString,
    message: Schema.optionalKey(NonEmptyString),
  }),
})

export const SetupClaimResponseSchema = Schema.Struct({
  vaultId: NonEmptyString,
  deviceId: NonEmptyString,
  claimedAt: NonNegativeInteger,
})

export const AuthChallengeResponseSchema = Schema.Struct({
  challengeId: NonEmptyString,
  challenge: NonEmptyString,
  expiresAt: Schema.optionalKey(NonNegativeInteger),
})

export const AuthSessionResponseSchema = Schema.Struct({
  sessionToken: NonEmptyString,
  deviceId: Schema.optionalKey(NonEmptyString),
  expiresAt: NonNegativeInteger,
})

export const RecoveryPackageResponseSchema = Schema.Struct({
  vaultId: Schema.optionalKey(NonEmptyString),
  recoverySigningPublicKey: Schema.optionalKey(NonEmptyString),
  encryptedRecoveryPackage: NonEmptyString,
  recoveryStateId: NonEmptyString,
})

export const RecoveryChallengeResponseSchema = Schema.Struct({
  challengeId: NonEmptyString,
  challenge: NonEmptyString,
  expiresAt: Schema.optionalKey(NonNegativeInteger),
  vaultId: Schema.optionalKey(NonEmptyString),
})

export const RecoveryClaimResponseSchema = Schema.Struct({
  vaultId: Schema.optionalKey(NonEmptyString),
  deviceId: Schema.optionalKey(NonEmptyString),
  recoveredAt: NonNegativeInteger,
  recoveryStateId: Schema.optionalKey(NonEmptyString),
  duplicate: Schema.optionalKey(Schema.Boolean),
})

export const StoredOperationSchema = Schema.Struct({
  cursor: NonNegativeInteger,
  operationId: NonEmptyString,
  authorDeviceId: NonEmptyString,
  epochId: NonEmptyString,
  type: StoredOperationTypeSchema,
  subjectDeviceId: Schema.optionalKey(NonEmptyString),
  envelope: NonEmptyString,
  signature: NonEmptyString,
  previousHash: NonEmptyString,
  chainHash: NonEmptyString,
  committedAt: NonNegativeInteger,
})

export type StoredOperation = typeof StoredOperationSchema.Type

export const ChangesResponseSchema = Schema.Struct({
  operations: Schema.Array(StoredOperationSchema),
  latestCursor: NonNegativeInteger,
  latestHash: Schema.optionalKey(NonEmptyString),
  hasMore: Schema.optionalKey(Schema.Boolean),
})

export const OperationReceiptResponseSchema = Schema.Struct({
  cursor: NonNegativeInteger,
  previousHash: Schema.optionalKey(NonEmptyString),
  chainHash: NonEmptyString,
  duplicate: Schema.optionalKey(Schema.Boolean),
})

export const DeviceSchema = Schema.Struct({
  deviceId: NonEmptyString,
  signingPublicKey: NonEmptyString,
  hpkePublicKey: NonEmptyString,
  certificate: NonEmptyString,
  role: Schema.Literals(["owner", "member"]),
  authorizedAt: NonNegativeInteger,
  authorizedBy: Schema.optionalKey(NullableString),
  revokedAt: NullableNonNegativeInteger,
  revokedOperationId: Schema.optionalKey(NullableString),
  deviceName: Schema.optionalKey(NullableString),
  platform: Schema.optionalKey(NullableString),
})

export type Device = typeof DeviceSchema.Type

export const DeviceListResponseSchema = Schema.Struct({
  devices: Schema.Array(DeviceSchema),
})

export const DeviceDescriptorResponseSchema = Schema.Struct({
  deviceId: NonEmptyString,
  deviceName: NonEmptyString,
  platform: NonEmptyString,
})

export const StorageResponseSchema = Schema.Struct({
  totalBytes: NonNegativeInteger,
  blobBytes: NonNegativeInteger,
  databaseBytes: NonNegativeInteger,
  blobCount: NonNegativeInteger,
  reservedBlobBytes: NonNegativeInteger,
  operationCount: NonNegativeInteger,
  checkpointCount: NonNegativeInteger,
  snapshotCount: NonNegativeInteger,
  retentionMode: Schema.Literal("forever"),
  activeDeviceCount: NonNegativeInteger,
  acknowledgedDeviceCount: NonNegativeInteger,
  minimumAcknowledgedCursor: NullableNonNegativeInteger,
  canPrune: Schema.Boolean,
})

export const StoragePruneResponseSchema = Schema.Struct({
  deletedBytes: NonNegativeInteger,
  deletedCount: NonNegativeInteger,
  graceDays: NonNegativeInteger,
})

export const RetentionAcknowledgementResponseSchema = Schema.Struct({
  acknowledged: Schema.Literal(true),
  duplicate: Schema.Boolean,
  cursor: NonNegativeInteger,
})

export const PairingStateSchema = Schema.Literals([
  "pending",
  "joined",
  "verifying",
  "confirmed",
  "released",
  "completed",
  "canceled",
])

export const PairingCapabilityResponseSchema = Schema.Struct({
  pairingId: NonEmptyString,
  capability: NonEmptyString,
  vaultId: NonEmptyString,
  expiresAt: NonNegativeInteger,
})

export const PairingCandidateSchema = Schema.Struct({
  pairingId: NonEmptyString,
  vaultId: NonEmptyString,
  expiresAt: NonNegativeInteger,
  deviceId: NonEmptyString,
  signingPublicKey: NonEmptyString,
  hpkePublicKey: NonEmptyString,
  deviceName: NonEmptyString,
  platform: NonEmptyString,
  requestProof: NonEmptyString,
})

export const PairingStatusResponseSchema = Schema.Struct({
  pairingId: NonEmptyString,
  status: PairingStateSchema,
  expiresAt: NonNegativeInteger,
  requestedAt: Schema.optionalKey(NullableNonNegativeInteger),
  ownerConfirmed: Schema.Boolean,
  candidateConfirmed: Schema.Boolean,
  candidateConfirmation: Schema.optionalKey(
    Schema.Struct({
      transferHash: NonEmptyString,
      proof: NonEmptyString,
    }),
  ),
  relayAvailable: Schema.optionalKey(Schema.Boolean),
  candidate: Schema.optionalKey(PairingCandidateSchema),
})

export const PairingResultResponseSchema = Schema.Struct({
  pairingId: NonEmptyString,
  status: PairingStateSchema,
  deviceId: Schema.optionalKey(NullableString),
  certificate: Schema.optionalKey(NullableString),
  transcriptHash: Schema.optionalKey(NullableString),
  verificationPreview: Schema.optionalKey(NullableString),
  approvalSignature: Schema.optionalKey(NullableString),
  hpkeTransfer: Schema.optionalKey(NullableString),
  verificationStartedAt: Schema.optionalKey(NullableNonNegativeInteger),
})
