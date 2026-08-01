import {
  blobId,
  certificateId,
  deviceId,
  ed25519Signature,
  epochId,
  fileId,
  hashBytes,
  nonce,
  operationId,
  revisionId,
  vaultId,
  wrappedRevisionKey,
} from "./bytes.js"
import { type CborValue, decodeCanonical, encodeCanonical } from "./canonical-cbor.js"
import { CIPHER_SUITE, Domain, OperationType } from "./constants.js"
import type {
  ChunkAssociatedData,
  DeviceRevocationOperation,
  EncryptedChunk,
  EpochTransitionOperation,
  LogFormatTransitionOperation,
  OperationBody,
  RevisionMetadata,
  RevisionOperation,
  SignedOperation,
} from "./models.js"
import {
  assertCurrentSuite,
  decodeEpochDeclaration,
  encodeEpochDeclaration,
  ProtocolDecodeError,
  signaturePayload,
  suiteToCbor,
} from "./wire.js"

function record(value: CborValue, label: string): Record<string, CborValue> {
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

function exact(value: Record<string, CborValue>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort().join("\0")
  const expected = [...keys].sort().join("\0")
  if (actual !== expected) throw new ProtocolDecodeError(`${label} has missing or unknown fields`)
}

function bytes(value: CborValue | undefined, length: number, label: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength !== length) {
    throw new ProtocolDecodeError(`${label} must contain exactly ${length} bytes`)
  }
  return value
}

function boundedBytes(
  value: CborValue | undefined,
  minimum: number,
  maximum: number,
  label: string,
): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength < minimum || value.byteLength > maximum) {
    throw new ProtocolDecodeError(`${label} has an invalid length`)
  }
  return value
}

function integer(value: CborValue | undefined, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ProtocolDecodeError(`${label} must be a non-negative safe integer`)
  }
  return value
}

function text(value: CborValue | undefined, label: string): string {
  if (typeof value !== "string") throw new ProtocolDecodeError(`${label} must be text`)
  return value
}

function chunkToCbor(chunk: EncryptedChunk): CborValue {
  return {
    blobId: chunk.blobId,
    chunkIndex: chunk.chunkIndex,
    plaintextLength: chunk.plaintextLength,
    nonce: chunk.nonce,
  }
}

export function associatedDataToCbor(aad: ChunkAssociatedData): CborValue {
  return {
    domain: Domain.AssociatedData,
    protocolGeneration: aad.protocolGeneration,
    suite: suiteToCbor(),
    vaultId: aad.vaultId,
    epochId: aad.epochId,
    fileId: aad.fileId,
    revisionId: aad.revisionId,
    operationType: aad.operationType,
    objectKind: aad.objectKind,
    chunkIndex: aad.chunkIndex,
    chunkCount: aad.chunkCount,
  }
}

export function encodeAssociatedData(aad: ChunkAssociatedData): Uint8Array {
  if (aad.protocolGeneration !== CIPHER_SUITE.protocolGeneration) {
    throw new RangeError("Associated data uses an unsupported protocol generation")
  }
  if (aad.chunkCount < 1 || aad.chunkIndex < 0 || aad.chunkIndex >= aad.chunkCount) {
    throw new RangeError("Associated data has an invalid chunk position")
  }
  return encodeCanonical(associatedDataToCbor(aad))
}

export function revisionMetadataToCbor(metadata: RevisionMetadata): CborValue {
  return {
    normalizedPath: metadata.normalizedPath,
    parents: metadata.parents,
    tombstone: metadata.tombstone,
    contentType: metadata.contentType,
    totalPlaintextLength: metadata.totalPlaintextLength,
    createdAt: metadata.createdAt,
  }
}

function isPortableNormalizedPath(path: string): boolean {
  if (
    path.length === 0 ||
    path !== path.normalize("NFC") ||
    path.startsWith("/") ||
    path.endsWith("/") ||
    path.includes("\\") ||
    path.includes("\0")
  ) {
    return false
  }
  return path
    .split("/")
    .every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
}

export function encodeRevisionMetadata(metadata: RevisionMetadata): Uint8Array {
  if (!isPortableNormalizedPath(metadata.normalizedPath)) {
    throw new TypeError("Revision paths must be normalized, relative, and portable")
  }
  return encodeCanonical(revisionMetadataToCbor(metadata))
}

export function decodeRevisionMetadata(encoded: Uint8Array): RevisionMetadata {
  const value = record(decodeCanonical(encoded), "revision metadata")
  exact(
    value,
    ["normalizedPath", "parents", "tombstone", "contentType", "totalPlaintextLength", "createdAt"],
    "revision metadata",
  )
  const normalizedPath = text(value.normalizedPath, "normalized path")
  if (!isPortableNormalizedPath(normalizedPath)) {
    throw new ProtocolDecodeError("Revision path is not normalized and relative")
  }
  if (!Array.isArray(value.parents))
    throw new ProtocolDecodeError("Revision parents must be an array")
  const parents = value.parents.map((parent) => revisionId(bytes(parent, 16, "parent revision ID")))
  if (new Set(parents.map((parent) => [...parent].join(","))).size !== parents.length) {
    throw new ProtocolDecodeError("Revision parent IDs must be unique")
  }
  if (typeof value.tombstone !== "boolean")
    throw new ProtocolDecodeError("Tombstone must be boolean")
  const contentType = text(value.contentType, "content type")
  if (contentType !== "binary" && contentType !== "utf8-text") {
    throw new ProtocolDecodeError("Unknown revision content type")
  }
  const totalPlaintextLength = integer(value.totalPlaintextLength, "plaintext length")
  if (value.tombstone && totalPlaintextLength !== 0) {
    throw new ProtocolDecodeError("Tombstones cannot contain plaintext")
  }
  return {
    normalizedPath,
    parents,
    tombstone: value.tombstone,
    contentType,
    totalPlaintextLength,
    createdAt: integer(value.createdAt, "revision creation time"),
  }
}

export function operationBodyToCbor(body: OperationBody): CborValue {
  const common = {
    type: body.type,
    operationId: body.operationId,
    vaultId: body.vaultId,
    epochId: body.epochId,
    authorDeviceId: body.authorDeviceId,
    suite: suiteToCbor(),
  }
  if (body.type === OperationType.Revision) {
    return {
      ...common,
      fileId: body.fileId,
      revisionId: body.revisionId,
      wrappedRevisionKey: body.wrappedRevisionKey,
      metadataNonce: body.metadataNonce,
      encryptedMetadata: body.encryptedMetadata,
      chunks: body.chunks.map(chunkToCbor),
    }
  }
  if (body.type === OperationType.DeviceRevocation) {
    return { ...common, certificateId: body.certificateId, reason: body.reason }
  }
  if (body.type === OperationType.EpochTransition) {
    return { ...common, declaration: encodeEpochDeclaration(body.declaration) }
  }
  return {
    ...common,
    previousCursor: body.previousCursor,
    previousLogHash: body.previousLogHash,
    nextLogFormat: body.nextLogFormat,
  }
}

export function operationSigningBytes(body: OperationBody): Uint8Array {
  return signaturePayload(Domain.Operation, operationBodyToCbor(body))
}

export function encodeOperation(operation: SignedOperation): Uint8Array {
  return encodeCanonical({
    body: operationBodyToCbor(operation.body),
    signature: operation.signature,
  })
}

function decodeCommon(value: Record<string, CborValue>) {
  assertCurrentSuite(value.suite)
  const author = value.authorDeviceId
  return {
    operationId: operationId(bytes(value.operationId, 16, "operation ID")),
    vaultId: vaultId(bytes(value.vaultId, 16, "vault ID")),
    epochId: epochId(bytes(value.epochId, 16, "epoch ID")),
    authorDeviceId:
      author === "recovery"
        ? ("recovery" as const)
        : deviceId(bytes(author, 16, "author device ID")),
    suite: CIPHER_SUITE,
  }
}

function decodeChunk(value: CborValue): EncryptedChunk {
  const chunk = record(value, "encrypted chunk")
  exact(chunk, ["blobId", "chunkIndex", "plaintextLength", "nonce"], "encrypted chunk")
  return {
    blobId: blobId(bytes(chunk.blobId, 16, "blob ID")),
    chunkIndex: integer(chunk.chunkIndex, "chunk index"),
    plaintextLength: integer(chunk.plaintextLength, "chunk plaintext length"),
    nonce: nonce(bytes(chunk.nonce, 12, "chunk nonce")),
  }
}

function decodeRevision(value: Record<string, CborValue>): RevisionOperation {
  exact(
    value,
    [
      "type",
      "operationId",
      "vaultId",
      "epochId",
      "authorDeviceId",
      "suite",
      "fileId",
      "revisionId",
      "wrappedRevisionKey",
      "metadataNonce",
      "encryptedMetadata",
      "chunks",
    ],
    "revision operation",
  )
  const common = decodeCommon(value)
  if (common.authorDeviceId === "recovery") {
    throw new ProtocolDecodeError("Recovery identity cannot author file revisions")
  }
  if (!Array.isArray(value.chunks))
    throw new ProtocolDecodeError("Revision chunks must be an array")
  const chunks = value.chunks.map(decodeChunk)
  chunks.forEach((chunk, index) => {
    if (chunk.chunkIndex !== index)
      throw new ProtocolDecodeError("Chunk indices must be contiguous")
  })
  return {
    type: "revision",
    ...common,
    authorDeviceId: common.authorDeviceId,
    fileId: fileId(bytes(value.fileId, 16, "file ID")),
    revisionId: revisionId(bytes(value.revisionId, 16, "revision ID")),
    wrappedRevisionKey: wrappedRevisionKey(
      bytes(value.wrappedRevisionKey, 40, "wrapped revision key"),
    ),
    metadataNonce: nonce(bytes(value.metadataNonce, 12, "metadata nonce")),
    encryptedMetadata: boundedBytes(
      value.encryptedMetadata,
      16,
      4 * 1024 * 1024,
      "encrypted metadata",
    ),
    chunks,
  }
}

function decodeRevocation(value: Record<string, CborValue>): DeviceRevocationOperation {
  exact(
    value,
    [
      "type",
      "operationId",
      "vaultId",
      "epochId",
      "authorDeviceId",
      "suite",
      "certificateId",
      "reason",
    ],
    "device revocation operation",
  )
  const reason = text(value.reason, "revocation reason")
  if (!["lost", "compromised", "replaced", "retired"].includes(reason)) {
    throw new ProtocolDecodeError("Unknown revocation reason")
  }
  return {
    type: "device-revocation",
    ...decodeCommon(value),
    certificateId: certificateId(bytes(value.certificateId, 16, "revoked certificate ID")),
    reason: reason as DeviceRevocationOperation["reason"],
  }
}

function decodeLogFormatTransition(value: Record<string, CborValue>): LogFormatTransitionOperation {
  exact(
    value,
    [
      "type",
      "operationId",
      "vaultId",
      "epochId",
      "authorDeviceId",
      "suite",
      "previousCursor",
      "previousLogHash",
      "nextLogFormat",
    ],
    "log format transition operation",
  )
  const common = decodeCommon(value)
  if (common.authorDeviceId === "recovery") {
    throw new ProtocolDecodeError("Recovery identity cannot authorize an interactive log upgrade")
  }
  if (value.nextLogFormat !== "canonical-cbor-v1") {
    throw new ProtocolDecodeError("Log format transition target is unsupported")
  }
  return {
    type: "log-format-transition",
    ...common,
    authorDeviceId: common.authorDeviceId,
    previousCursor: integer(value.previousCursor, "previous log cursor"),
    previousLogHash: hashBytes(bytes(value.previousLogHash, 32, "previous log hash")),
    nextLogFormat: value.nextLogFormat,
  }
}

function decodeEpochTransition(value: Record<string, CborValue>): EpochTransitionOperation {
  exact(
    value,
    ["type", "operationId", "vaultId", "epochId", "authorDeviceId", "suite", "declaration"],
    "epoch transition operation",
  )
  if (!(value.declaration instanceof Uint8Array)) {
    throw new ProtocolDecodeError("Epoch declaration must be canonical CBOR bytes")
  }
  return {
    type: "epoch-transition",
    ...decodeCommon(value),
    declaration: decodeEpochDeclaration(value.declaration),
  }
}

export function decodeOperation(encoded: Uint8Array): SignedOperation {
  const envelope = record(decodeCanonical(encoded), "signed operation")
  exact(envelope, ["body", "signature"], "signed operation")
  const body = record(envelope.body as CborValue, "operation body")
  const type = text(body.type, "operation type")
  let decoded: OperationBody
  if (type === OperationType.Revision) decoded = decodeRevision(body)
  else if (type === OperationType.DeviceRevocation) decoded = decodeRevocation(body)
  else if (type === OperationType.EpochTransition) decoded = decodeEpochTransition(body)
  else if (type === OperationType.LogFormatTransition) decoded = decodeLogFormatTransition(body)
  else throw new ProtocolDecodeError("Unknown operation type")

  return {
    body: decoded,
    signature: ed25519Signature(bytes(envelope.signature, 64, "operation signature")),
  }
}
