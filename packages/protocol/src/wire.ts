import {
  type CertificateId,
  certificateId,
  type DeviceId,
  deviceId,
  ed25519PublicKey,
  ed25519Signature,
  epochId,
  type Hash,
  hashBytes,
  pairingId,
  vaultId,
  x25519PublicKey,
} from "./bytes.js"
import { type CborValue, decodeCanonical, encodeCanonical } from "./canonical-cbor.js"
import {
  CIPHER_SUITE,
  Domain,
  type LogFormat,
  LogFormat as LogFormats,
  MAX_SAFE_CURSOR,
  Permission,
} from "./constants.js"
import type {
  CheckpointBody,
  DeviceCertificate,
  DeviceCertificateBody,
  EpochDeclaration,
  EpochDeclarationBody,
  PairingContext,
  PairingDeviceMetadata,
  Signed,
  SignedCheckpoint,
} from "./models.js"

const utf8Encoder = new TextEncoder()
const utf8Decoder = new TextDecoder()

export class ProtocolDecodeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ProtocolDecodeError"
  }
}

function record(value: unknown, label: string): Record<string, CborValue> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value instanceof Uint8Array ||
    value instanceof Map
  ) {
    throw new ProtocolDecodeError(`${label} must be a CBOR map`)
  }
  return value as Record<string, CborValue>
}

function exactKeys(value: Record<string, CborValue>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new ProtocolDecodeError(`${label} has missing or unknown fields`)
  }
}

function bytes(value: CborValue | undefined, length: number, label: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength !== length) {
    throw new ProtocolDecodeError(`${label} must be a ${length}-byte string`)
  }
  return value
}

function text(value: CborValue | undefined, label: string): string {
  if (typeof value !== "string") throw new ProtocolDecodeError(`${label} must be text`)
  return value
}

function decodeLogFormat(value: CborValue | undefined, label: string): LogFormat {
  const format = text(value, label)
  if (format !== LogFormats.LegacyHttpV1 && format !== LogFormats.CanonicalCborV1) {
    throw new ProtocolDecodeError(`${label} is unsupported`)
  }
  return format
}

function boundedText(value: CborValue | undefined, maximum: number, label: string): string {
  const decoded = text(value, label)
  if (utf8Decoder.decode(utf8Encoder.encode(decoded)) !== decoded) {
    throw new ProtocolDecodeError(`${label} must be valid Unicode text`)
  }
  const length = [...decoded].length
  if (length < 1 || length > maximum) {
    throw new ProtocolDecodeError(`${label} must contain between 1 and ${maximum} characters`)
  }
  return decoded
}

export function assertPairingDeviceMetadata(metadata: PairingDeviceMetadata): void {
  boundedText(metadata.deviceName, 80, "pairing device name")
  boundedText(metadata.platform, 32, "pairing device platform")
}

function integer(value: CborValue | undefined, label: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_SAFE_CURSOR
  ) {
    throw new ProtocolDecodeError(`${label} must be a non-negative safe integer`)
  }
  return value
}

function nullableInteger(value: CborValue | undefined, label: string): number | null {
  return value === null ? null : integer(value, label)
}

function array(value: CborValue | undefined, label: string): readonly CborValue[] {
  if (!Array.isArray(value)) throw new ProtocolDecodeError(`${label} must be an array`)
  return value
}

export function suiteToCbor(): CborValue {
  return {
    protocolGeneration: CIPHER_SUITE.protocolGeneration,
    encoding: CIPHER_SUITE.encoding,
    kem: CIPHER_SUITE.kem,
    kdf: CIPHER_SUITE.kdf,
    aead: CIPHER_SUITE.aead,
    keyWrap: CIPHER_SUITE.keyWrap,
    signature: CIPHER_SUITE.signature,
    hash: CIPHER_SUITE.hash,
  }
}

export function assertCurrentSuite(value: CborValue | undefined): void {
  const suite = record(value, "cipher suite")
  exactKeys(
    suite,
    ["protocolGeneration", "encoding", "kem", "kdf", "aead", "keyWrap", "signature", "hash"],
    "cipher suite",
  )
  const expected = suiteToCbor() as Record<string, CborValue>
  for (const key of Object.keys(expected)) {
    if (suite[key] !== expected[key])
      throw new ProtocolDecodeError(`Unsupported cipher suite field: ${key}`)
  }
}

export function signaturePayload(domain: string, body: CborValue): Uint8Array {
  return encodeCanonical({ domain, body })
}

function issuerToCbor(issuer: DeviceCertificateBody["issuer"]): CborValue {
  return issuer.kind === "recovery"
    ? { kind: "recovery" }
    : { kind: "device", certificateId: issuer.certificateId }
}

function assertCanonicalPermissions(permissions: readonly string[]): void {
  const canonical = Object.values(Permission).filter((permission) =>
    permissions.includes(permission),
  )
  if (
    canonical.length !== permissions.length ||
    canonical.some((permission, index) => permission !== permissions[index])
  ) {
    throw new ProtocolDecodeError("Certificate permissions must be unique and canonically ordered")
  }
}

export function certificateBodyToCbor(body: DeviceCertificateBody): CborValue {
  assertCanonicalPermissions(body.permissions)
  return {
    certificateId: body.certificateId,
    vaultId: body.vaultId,
    deviceId: body.deviceId,
    signingPublicKey: body.signingPublicKey,
    hpkePublicKey: body.hpkePublicKey,
    permissions: body.permissions,
    issuer: issuerToCbor(body.issuer),
    epochId: body.epochId,
    suite: suiteToCbor(),
    validFromCursor: body.validFromCursor,
    expiresAt: body.expiresAt,
  }
}

export function certificateSigningBytes(body: DeviceCertificateBody): Uint8Array {
  return signaturePayload(Domain.Certificate, certificateBodyToCbor(body))
}

export function deviceCertificateToCbor(certificate: DeviceCertificate): CborValue {
  return { body: certificateBodyToCbor(certificate.body), signature: certificate.signature }
}

export function encodeDeviceCertificate(certificate: DeviceCertificate): Uint8Array {
  return encodeCanonical(deviceCertificateToCbor(certificate))
}

function decodeIssuer(value: CborValue | undefined): DeviceCertificateBody["issuer"] {
  const issuer = record(value, "certificate issuer")
  const kind = text(issuer.kind, "certificate issuer kind")
  if (kind === "recovery") {
    exactKeys(issuer, ["kind"], "recovery certificate issuer")
    return { kind }
  }
  if (kind === "device") {
    exactKeys(issuer, ["kind", "certificateId"], "device certificate issuer")
    return {
      kind,
      certificateId: certificateId(bytes(issuer.certificateId, 16, "issuer certificate ID")),
    }
  }
  throw new ProtocolDecodeError("Unknown certificate issuer kind")
}

function decodeCertificateBody(value: CborValue): DeviceCertificateBody {
  const body = record(value, "device certificate body")
  exactKeys(
    body,
    [
      "certificateId",
      "vaultId",
      "deviceId",
      "signingPublicKey",
      "hpkePublicKey",
      "permissions",
      "issuer",
      "epochId",
      "suite",
      "validFromCursor",
      "expiresAt",
    ],
    "device certificate body",
  )
  assertCurrentSuite(body.suite)
  const permissions = array(body.permissions, "certificate permissions").map((permission) => {
    if (!Object.values(Permission).includes(permission as never)) {
      throw new ProtocolDecodeError("Unknown device permission")
    }
    return permission as DeviceCertificateBody["permissions"][number]
  })
  assertCanonicalPermissions(permissions)

  return {
    certificateId: certificateId(bytes(body.certificateId, 16, "certificate ID")),
    vaultId: vaultId(bytes(body.vaultId, 16, "vault ID")),
    deviceId: deviceId(bytes(body.deviceId, 16, "device ID")),
    signingPublicKey: ed25519PublicKey(bytes(body.signingPublicKey, 32, "signing public key")),
    hpkePublicKey: x25519PublicKey(bytes(body.hpkePublicKey, 32, "HPKE public key")),
    permissions,
    issuer: decodeIssuer(body.issuer),
    epochId: epochId(bytes(body.epochId, 16, "epoch ID")),
    suite: CIPHER_SUITE,
    validFromCursor: integer(body.validFromCursor, "valid-from cursor"),
    expiresAt: nullableInteger(body.expiresAt, "certificate expiry"),
  }
}

export function decodeDeviceCertificateValue(value: CborValue): DeviceCertificate {
  const envelope = record(value, "device certificate")
  exactKeys(envelope, ["body", "signature"], "device certificate")
  return {
    body: decodeCertificateBody(envelope.body as CborValue),
    signature: ed25519Signature(bytes(envelope.signature, 64, "certificate signature")),
  }
}

export function decodeDeviceCertificate(encoded: Uint8Array): DeviceCertificate {
  return decodeDeviceCertificateValue(decodeCanonical(encoded))
}

export function epochBodyToCbor(body: EpochDeclarationBody): CborValue {
  return {
    vaultId: body.vaultId,
    epochId: body.epochId,
    sequence: body.sequence,
    previousEpochId: body.previousEpochId,
    suite: suiteToCbor(),
    createdBy: body.createdBy,
    reason: body.reason,
  }
}

export function epochSigningBytes(body: EpochDeclarationBody): Uint8Array {
  return signaturePayload(Domain.Epoch, epochBodyToCbor(body))
}

export function epochDeclarationToCbor(epoch: EpochDeclaration): CborValue {
  return { body: epochBodyToCbor(epoch.body), signature: epoch.signature }
}

export function encodeEpochDeclaration(epoch: EpochDeclaration): Uint8Array {
  return encodeCanonical(epochDeclarationToCbor(epoch))
}

function decodeEpochBody(value: CborValue): EpochDeclarationBody {
  const body = record(value, "epoch body")
  exactKeys(
    body,
    ["vaultId", "epochId", "sequence", "previousEpochId", "suite", "createdBy", "reason"],
    "epoch body",
  )
  assertCurrentSuite(body.suite)
  const createdByValue = body.createdBy
  const createdBy =
    createdByValue === "recovery"
      ? "recovery"
      : deviceId(bytes(createdByValue, 16, "epoch creator device ID"))
  const reason = text(body.reason, "epoch reason")
  if (!["initial", "scheduled", "revocation", "recovery", "migration"].includes(reason)) {
    throw new ProtocolDecodeError("Unknown epoch transition reason")
  }
  return {
    vaultId: vaultId(bytes(body.vaultId, 16, "vault ID")),
    epochId: epochId(bytes(body.epochId, 16, "epoch ID")),
    sequence: integer(body.sequence, "epoch sequence"),
    previousEpochId:
      body.previousEpochId === null
        ? null
        : epochId(bytes(body.previousEpochId, 16, "previous epoch ID")),
    suite: CIPHER_SUITE,
    createdBy,
    reason: reason as EpochDeclarationBody["reason"],
  }
}

export function decodeEpochDeclarationValue(value: CborValue): EpochDeclaration {
  const envelope = record(value, "epoch declaration")
  exactKeys(envelope, ["body", "signature"], "epoch declaration")
  return {
    body: decodeEpochBody(envelope.body as CborValue),
    signature: ed25519Signature(bytes(envelope.signature, 64, "epoch signature")),
  }
}

export function decodeEpochDeclaration(encoded: Uint8Array): EpochDeclaration {
  return decodeEpochDeclarationValue(decodeCanonical(encoded))
}

export function checkpointBodyToCbor(body: CheckpointBody): CborValue {
  const hasInitialFormat = body.initialLogFormat !== undefined
  const hasCurrentFormat = body.logFormat !== undefined
  if (hasInitialFormat !== hasCurrentFormat) {
    throw new TypeError("Checkpoint log formats must be present together")
  }
  checkpointLogFormats(body)
  return {
    vaultId: body.vaultId,
    epochId: body.epochId,
    cursor: body.cursor,
    logHash: body.logHash,
    signerDeviceId: body.signerDeviceId,
    protocolGeneration: body.protocolGeneration,
    ...(hasInitialFormat
      ? { initialLogFormat: body.initialLogFormat, logFormat: body.logFormat }
      : {}),
  }
}

export function checkpointLogFormats(
  body: Pick<CheckpointBody, "initialLogFormat" | "logFormat">,
): {
  initialLogFormat: LogFormat
  logFormat: LogFormat
} {
  if (body.initialLogFormat === undefined && body.logFormat === undefined) {
    return {
      initialLogFormat: LogFormats.LegacyHttpV1,
      logFormat: LogFormats.LegacyHttpV1,
    }
  }
  if (body.initialLogFormat === undefined || body.logFormat === undefined) {
    throw new TypeError("Checkpoint log formats must be present together")
  }
  if (
    body.initialLogFormat === LogFormats.CanonicalCborV1 &&
    body.logFormat === LogFormats.LegacyHttpV1
  ) {
    throw new TypeError("Checkpoint log format cannot move backwards")
  }
  return { initialLogFormat: body.initialLogFormat, logFormat: body.logFormat }
}

export function checkpointSigningBytes(body: CheckpointBody): Uint8Array {
  return signaturePayload(Domain.Checkpoint, checkpointBodyToCbor(body))
}

export function checkpointToCbor(checkpoint: SignedCheckpoint): CborValue {
  return { body: checkpointBodyToCbor(checkpoint.body), signature: checkpoint.signature }
}

export function encodeCheckpoint(checkpoint: SignedCheckpoint): Uint8Array {
  return encodeCanonical(checkpointToCbor(checkpoint))
}

export function decodeCheckpointValue(value: CborValue): SignedCheckpoint {
  const envelope = record(value, "checkpoint")
  exactKeys(envelope, ["body", "signature"], "checkpoint")
  const body = record(envelope.body, "checkpoint body")
  const legacyKeys = [
    "vaultId",
    "epochId",
    "cursor",
    "logHash",
    "signerDeviceId",
    "protocolGeneration",
  ]
  const versionedKeys = [...legacyKeys, "initialLogFormat", "logFormat"]
  if ("initialLogFormat" in body || "logFormat" in body) {
    exactKeys(body, versionedKeys, "checkpoint body")
  } else {
    exactKeys(body, legacyKeys, "checkpoint body")
  }
  const protocolGeneration = integer(body.protocolGeneration, "checkpoint protocol generation")
  if (protocolGeneration !== CIPHER_SUITE.protocolGeneration) {
    throw new ProtocolDecodeError("Unsupported checkpoint protocol generation")
  }
  const checkpoint: SignedCheckpoint = {
    body: {
      vaultId: vaultId(bytes(body.vaultId, 16, "vault ID")),
      epochId: epochId(bytes(body.epochId, 16, "epoch ID")),
      cursor: integer(body.cursor, "checkpoint cursor"),
      logHash: hashBytes(bytes(body.logHash, 32, "checkpoint log hash")),
      signerDeviceId: deviceId(bytes(body.signerDeviceId, 16, "checkpoint signer device ID")),
      protocolGeneration,
      ...(body.initialLogFormat === undefined
        ? {}
        : {
            initialLogFormat: decodeLogFormat(body.initialLogFormat, "initial log format"),
            logFormat: decodeLogFormat(body.logFormat, "current log format"),
          }),
    },
    signature: ed25519Signature(bytes(envelope.signature, 64, "checkpoint signature")),
  }
  try {
    checkpointLogFormats(checkpoint.body)
  } catch (error) {
    throw new ProtocolDecodeError(error instanceof Error ? error.message : "Invalid log formats")
  }
  return checkpoint
}

export function decodeCheckpoint(encoded: Uint8Array): SignedCheckpoint {
  return decodeCheckpointValue(decodeCanonical(encoded))
}

export function pairingContextToCbor(context: PairingContext): CborValue {
  assertPairingDeviceMetadata({
    deviceName: context.newDeviceName,
    platform: context.newDevicePlatform,
  })
  return {
    pairingId: context.pairingId,
    vaultId: context.vaultId,
    newDeviceId: context.newDeviceId,
    newDeviceSigningPublicKey: context.newDeviceSigningPublicKey,
    newDeviceHpkePublicKey: context.newDeviceHpkePublicKey,
    newDeviceName: context.newDeviceName,
    newDevicePlatform: context.newDevicePlatform,
    certificate: deviceCertificateToCbor(context.certificate),
    authorizationChain: context.authorizationChain.map(deviceCertificateToCbor),
    recoveryPublicKey: context.recoveryPublicKey,
    epoch: epochDeclarationToCbor(context.epoch),
    checkpoint: checkpointToCbor(context.checkpoint),
    expiresAt: context.expiresAt,
    suite: suiteToCbor(),
  }
}

export function decodePairingContextValue(value: CborValue): PairingContext {
  const context = record(value, "pairing context")
  exactKeys(
    context,
    [
      "pairingId",
      "vaultId",
      "newDeviceId",
      "newDeviceSigningPublicKey",
      "newDeviceHpkePublicKey",
      "newDeviceName",
      "newDevicePlatform",
      "certificate",
      "authorizationChain",
      "recoveryPublicKey",
      "epoch",
      "checkpoint",
      "expiresAt",
      "suite",
    ],
    "pairing context",
  )
  assertCurrentSuite(context.suite)
  const chain = array(context.authorizationChain, "pairing authorization chain").map(
    decodeDeviceCertificateValue,
  )
  if (chain.length === 0 || chain.length > 32) {
    throw new ProtocolDecodeError("Pairing authorization chain has an invalid length")
  }
  return {
    pairingId: pairingId(bytes(context.pairingId, 16, "pairing ID")),
    vaultId: vaultId(bytes(context.vaultId, 16, "vault ID")),
    newDeviceId: deviceId(bytes(context.newDeviceId, 16, "new device ID")),
    newDeviceSigningPublicKey: ed25519PublicKey(
      bytes(context.newDeviceSigningPublicKey, 32, "new signing public key"),
    ),
    newDeviceHpkePublicKey: x25519PublicKey(
      bytes(context.newDeviceHpkePublicKey, 32, "new HPKE public key"),
    ),
    newDeviceName: boundedText(context.newDeviceName, 80, "new device name"),
    newDevicePlatform: boundedText(context.newDevicePlatform, 32, "new device platform"),
    certificate: decodeDeviceCertificateValue(context.certificate as CborValue),
    authorizationChain: chain,
    recoveryPublicKey: ed25519PublicKey(
      bytes(context.recoveryPublicKey, 32, "recovery public key"),
    ),
    epoch: decodeEpochDeclarationValue(context.epoch as CborValue),
    checkpoint: decodeCheckpointValue(context.checkpoint as CborValue),
    expiresAt: integer(context.expiresAt, "pairing expiry"),
    suite: CIPHER_SUITE,
  }
}

export function pairingInfoBytes(context: PairingContext): Uint8Array {
  return signaturePayload(Domain.PairingInfo, pairingContextToCbor(context))
}

export function pairingTransferSigningBytes(
  context: PairingContext,
  transfer: { readonly encapsulatedKey: Uint8Array; readonly ciphertext: Uint8Array },
  approverDeviceId: DeviceId,
): Uint8Array {
  return signaturePayload(Domain.PairingTransfer, {
    context: pairingContextToCbor(context),
    transfer: {
      encapsulatedKey: transfer.encapsulatedKey,
      ciphertext: transfer.ciphertext,
    },
    approverDeviceId,
  })
}

export function pairingVerificationPreviewSigningBytes(
  context: PairingContext,
  approverDeviceId: DeviceId,
  transferHash: Hash,
): Uint8Array {
  return signaturePayload(Domain.PairingVerificationPreview, {
    context: pairingContextToCbor(context),
    approverDeviceId,
    transferHash,
  })
}

export function decodePairingIdentity(value: Uint8Array): {
  pairingId: ReturnType<typeof pairingId>
  vaultId: ReturnType<typeof vaultId>
} {
  const decoded = record(decodeCanonical(value), "pairing identity")
  exactKeys(decoded, ["pairingId", "vaultId"], "pairing identity")
  return {
    pairingId: pairingId(bytes(decoded.pairingId, 16, "pairing ID")),
    vaultId: vaultId(bytes(decoded.vaultId, 16, "vault ID")),
  }
}

export function encodeSigned<T>(
  domain: string,
  signed: Signed<T>,
  bodyToCbor: (body: T) => CborValue,
): Uint8Array {
  if (domain.length === 0) throw new TypeError("Signature domain must not be empty")
  return encodeCanonical({ body: bodyToCbor(signed.body), signature: signed.signature })
}

export type CertificateLookup = (certificateId: CertificateId) => DeviceCertificate | undefined
