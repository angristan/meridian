import { Schema } from "effect"

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
  logFormat: Schema.optionalKey(Schema.Literal("canonical-cbor-v1")),
  initialDevice: DevicePublicIdentitySchema,
  proof: Schema.String,
})

export type SetupClaim = typeof SetupClaimSchema.Type

export const AuthChallengeSchema = Schema.Struct({ deviceId: Schema.String })

export const AuthSessionSchema = Schema.Struct({
  deviceId: Schema.String,
  challengeId: Schema.String,
  signature: Schema.String,
  supportedLogFormats: Schema.optionalKey(Schema.Array(Schema.String)),
  supportedFeatures: Schema.optionalKey(Schema.Array(Schema.String)),
})

export type AuthSession = typeof AuthSessionSchema.Type

export const RecoveryClaimSchema = Schema.Struct({
  claimVersion: Schema.optionalKey(Schema.Number),
  recoveryId: Schema.optionalKey(Schema.String),
  previousRecoveryStateId: Schema.optionalKey(Schema.String),
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

export const OperationTypeSchema = Schema.Literals([
  "revision",
  "merge",
  "tombstone",
  "restore",
  "device-revocation",
  "key-epoch",
  "log-format-transition",
])

export const OperationSchema = Schema.Struct({
  operationId: Schema.String,
  authorDeviceId: Schema.String,
  epochId: Schema.String,
  type: OperationTypeSchema,
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

export const StoragePolicySchema = Schema.Struct({
  quotaBytes: Schema.NullOr(Schema.Number),
})

export type StoragePolicy = typeof StoragePolicySchema.Type

export const EmptyObjectSchema = Schema.Struct({})
