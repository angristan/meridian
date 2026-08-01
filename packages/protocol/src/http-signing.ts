const encoder = new TextEncoder()

export type SignedHttpField = readonly [name: string, value: string | Uint8Array | number]

/** Domain-separated, length-prefixed framing for signatures on the HTTP relay protocol. */
export function signedHttpMessage(
  domain: string,
  fields: ReadonlyArray<SignedHttpField>,
): Uint8Array {
  const header = encoder.encode(`MERIDIAN\u0000${domain}\u0000`)
  const chunks: Uint8Array[] = [header]
  let length = header.length

  for (const [name, rawValue] of fields) {
    const value =
      typeof rawValue === "string"
        ? encoder.encode(rawValue)
        : typeof rawValue === "number"
          ? encoder.encode(String(rawValue))
          : rawValue
    const prefix = encoder.encode(`${name}\u0000${value.length}\u0000`)
    chunks.push(prefix, value)
    length += prefix.length + value.length
  }

  const output = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.length
  }
  return output
}

export interface SetupClaimSigningInput {
  readonly vaultId: string
  readonly deviceId: string
  readonly signingPublicKey: string
  readonly hpkePublicKey: string
  readonly certificate: Uint8Array
  readonly recoverySigningPublicKey: string
  readonly encryptedRecoveryPackage: Uint8Array
  readonly setupSession: string
  readonly challenge: string
  readonly logFormat?: "canonical-cbor-v1"
}

export function setupClaimSigningBytes(input: SetupClaimSigningInput): Uint8Array {
  return signedHttpMessage("setup-claim/v1", [
    ["vault-id", input.vaultId],
    ["device-id", input.deviceId],
    ["signing-public-key", input.signingPublicKey],
    ["hpke-public-key", input.hpkePublicKey],
    ["certificate", input.certificate],
    ["recovery-signing-public-key", input.recoverySigningPublicKey],
    ["encrypted-recovery-package", input.encryptedRecoveryPackage],
    ["setup-session", input.setupSession],
    ["challenge", input.challenge],
    ...(input.logFormat === undefined ? [] : ([["log-format", input.logFormat]] as const)),
  ])
}

export interface DeviceAuthSigningInput {
  readonly vaultId: string
  readonly deviceId: string
  readonly challengeId: string
  readonly challenge: string
}

export function deviceAuthSigningBytes(input: DeviceAuthSigningInput): Uint8Array {
  return signedHttpMessage("device-auth/v1", [
    ["vault-id", input.vaultId],
    ["device-id", input.deviceId],
    ["challenge-id", input.challengeId],
    ["challenge", input.challenge],
  ])
}

export interface PairingJoinRequestSigningInput {
  readonly vaultId: string
  readonly pairingId: string
  readonly deviceId: string
  readonly signingPublicKey: string
  readonly hpkePublicKey: string
  readonly deviceName: string
  readonly platform: string
}

export function pairingJoinRequestSigningBytes(input: PairingJoinRequestSigningInput): Uint8Array {
  return signedHttpMessage("pairing-join/v1", [
    ["vault-id", input.vaultId],
    ["pairing-id", input.pairingId],
    ["device-id", input.deviceId],
    ["signing-public-key", input.signingPublicKey],
    ["hpke-public-key", input.hpkePublicKey],
    ["device-name", input.deviceName],
    ["platform", input.platform],
  ])
}

export interface PairingApprovalRequestSigningInput {
  readonly vaultId: string
  readonly pairingId: string
  readonly candidateDeviceId: string
  readonly candidateSigningPublicKey: string
  readonly candidateHpkePublicKey: string
  readonly certificate: Uint8Array
  readonly transcriptHash: string
  readonly hpkeTransfer: Uint8Array
}

export function pairingApprovalRequestSigningBytes(
  input: PairingApprovalRequestSigningInput,
): Uint8Array {
  return signedHttpMessage("pairing-approval/v1", [
    ["vault-id", input.vaultId],
    ["pairing-id", input.pairingId],
    ["candidate-device-id", input.candidateDeviceId],
    ["candidate-signing-public-key", input.candidateSigningPublicKey],
    ["candidate-hpke-public-key", input.candidateHpkePublicKey],
    ["certificate", input.certificate],
    ["transcript-hash", input.transcriptHash],
    ["hpke-transfer", input.hpkeTransfer],
  ])
}

export interface PairingCandidateStateSigningInput {
  readonly vaultId: string
  readonly pairingId: string
  readonly candidateDeviceId: string
  readonly transferHash: string
}

export function pairingCandidateConfirmationSigningBytes(
  input: PairingCandidateStateSigningInput,
): Uint8Array {
  return pairingCandidateStateSigningBytes("pairing-candidate-confirmation/v1", input)
}

export function pairingCompletionSigningBytes(
  input: PairingCandidateStateSigningInput,
): Uint8Array {
  return pairingCandidateStateSigningBytes("pairing-completion/v1", input)
}

function pairingCandidateStateSigningBytes(
  domain: string,
  input: PairingCandidateStateSigningInput,
): Uint8Array {
  return signedHttpMessage(domain, [
    ["vault-id", input.vaultId],
    ["pairing-id", input.pairingId],
    ["candidate-device-id", input.candidateDeviceId],
    ["transfer-hash", input.transferHash],
  ])
}

export interface HttpOperationSigningInput {
  readonly operationId: string
  readonly authorDeviceId: string
  readonly epochId: string
  readonly type: string
  readonly subjectDeviceId?: string
  readonly envelope: Uint8Array
}

export function httpOperationSigningBytes(input: HttpOperationSigningInput): Uint8Array {
  return signedHttpMessage("operation/v1", [
    ["operation-id", input.operationId],
    ["author-device-id", input.authorDeviceId],
    ["epoch-id", input.epochId],
    ["operation-type", input.type],
    ["subject-device-id", input.subjectDeviceId ?? ""],
    ["envelope", input.envelope],
  ])
}

export interface CursorArtifactSigningInput {
  readonly id: string
  readonly cursor: number
  readonly logHash: string
  readonly epochId: string
  readonly envelope: Uint8Array
}

export function checkpointUploadSigningBytes(input: CursorArtifactSigningInput): Uint8Array {
  return cursorArtifactSigningBytes("checkpoint/v1", "checkpoint-id", input)
}

export function snapshotUploadSigningBytes(input: CursorArtifactSigningInput): Uint8Array {
  return cursorArtifactSigningBytes("snapshot/v1", "snapshot-id", input)
}

function cursorArtifactSigningBytes(
  domain: string,
  idField: string,
  input: CursorArtifactSigningInput,
): Uint8Array {
  return signedHttpMessage(domain, [
    [idField, input.id],
    ["cursor", input.cursor],
    ["log-hash", input.logHash],
    ["epoch-id", input.epochId],
    ["envelope", input.envelope],
  ])
}

export function logChainSigningBytes(
  previousHash: Uint8Array,
  operation: Uint8Array,
  signature: Uint8Array,
): Uint8Array {
  return signedHttpMessage("log-chain/v1", [
    ["previous-hash", previousHash],
    ["operation", operation],
    ["signature", signature],
  ])
}
