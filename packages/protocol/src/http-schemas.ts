import { Schema } from "effect"

/** HTTP transports binary values as unpadded base64url; CBOR uses byte strings directly. */
export const Base64Url = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^(?:[A-Za-z0-9_-]{2,})$/, { identifier: "unpadded base64url" })),
)

export const OpaqueId = Base64Url.pipe(
  Schema.check(Schema.isLengthBetween(22, 22, { identifier: "128-bit base64url identifier" })),
)

export const AuthChallengeRequest = Schema.Struct({
  vaultId: OpaqueId,
  deviceId: OpaqueId,
})

export const AuthSessionRequest = Schema.Struct({
  challengeId: Schema.String,
  vaultId: OpaqueId,
  deviceId: OpaqueId,
  signature: Base64Url,
})

export const OperationSubmission = Schema.Struct({
  idempotencyKey: OpaqueId,
  operation: Base64Url,
})

export const PairingSubmission = Schema.Struct({
  pairingId: OpaqueId,
  newDeviceId: OpaqueId,
  signingPublicKey: Base64Url,
  hpkePublicKey: Base64Url,
  proofOfPossession: Base64Url,
})

export const ChangeQuery = Schema.Struct({
  after: Schema.Number,
  logHash: Base64Url,
})

export const decodeAuthChallengeRequest = Schema.decodeUnknownSync(AuthChallengeRequest, {
  onExcessProperty: "error",
})
export const decodeAuthSessionRequest = Schema.decodeUnknownSync(AuthSessionRequest, {
  onExcessProperty: "error",
})
export const decodeOperationSubmission = Schema.decodeUnknownSync(OperationSubmission, {
  onExcessProperty: "error",
})
export const decodePairingSubmission = Schema.decodeUnknownSync(PairingSubmission, {
  onExcessProperty: "error",
})
export const decodeChangeQuery = Schema.decodeUnknownSync(ChangeQuery, {
  onExcessProperty: "error",
})
