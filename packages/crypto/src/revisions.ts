import {
  type BlobId,
  blobId,
  bytesEqual,
  CIPHER_SUITE,
  type DeviceCertificate,
  decodeOperation,
  decodeRevisionMetadata,
  encodeAssociatedData,
  encodeOperation,
  encodeRevisionMetadata,
  type FileId,
  fileId,
  OperationType,
  operationId,
  Permission,
  type RevisionId,
  type RevisionMetadata,
  type RevisionOperation,
  revisionId,
  type SignedOperation,
} from "@meridian/protocol"
import { aesGcmDecrypt, RevisionCipher, unwrapRevisionKey, wrapRevisionKey } from "./aes.js"
import { signOperation, verifyOperation } from "./authorization.js"
import { AuthenticationError, AuthorizationError, CryptoError } from "./errors.js"
import type { DeviceKeyBundle } from "./lifecycle.js"
import { randomBytes } from "./runtime.js"

const DEFAULT_CHUNK_SIZE = 4 * 1024 * 1024
const MAX_CHUNK_SIZE = 8 * 1024 * 1024

export interface EncryptFileRevisionInput {
  readonly device: DeviceKeyBundle
  readonly normalizedPath: string
  readonly content: Uint8Array | null
  readonly contentType: "binary" | "utf8-text"
  readonly fileId?: FileId
  readonly revisionId?: RevisionId
  readonly parents?: readonly RevisionId[]
  readonly createdAt: number
  readonly chunkSize?: number
}

export interface EncryptedBlob {
  readonly blobId: BlobId
  readonly ciphertext: Uint8Array
}

export interface EncryptedFileRevision {
  /** Opaque canonical envelope submitted to POST /v1/operations. */
  readonly operationBytes: Uint8Array
  readonly operation: SignedOperation
  /** Upload every immutable ciphertext blob before submitting operationBytes. */
  readonly blobs: readonly EncryptedBlob[]
}

function chunkContent(content: Uint8Array, chunkSize: number): readonly Uint8Array[] {
  const chunks: Uint8Array[] = []
  for (let offset = 0; offset < content.byteLength; offset += chunkSize) {
    chunks.push(content.slice(offset, Math.min(offset + chunkSize, content.byteLength)))
  }
  return chunks
}

export async function encryptFileRevision(
  input: EncryptFileRevisionInput,
): Promise<EncryptedFileRevision> {
  if (!input.device.certificate.body.permissions.includes(Permission.Write)) {
    throw new AuthorizationError("Device certificate does not permit revisions")
  }
  if (!Number.isSafeInteger(input.createdAt) || input.createdAt < 0) {
    throw new RangeError("Revision creation time must be a non-negative safe integer")
  }
  const chunkSize = input.chunkSize ?? DEFAULT_CHUNK_SIZE
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1 || chunkSize > MAX_CHUNK_SIZE) {
    throw new RangeError("Revision chunk size must be between 1 byte and 8 MiB")
  }
  const fileIdentifier = input.fileId ?? fileId(randomBytes(16))
  const revisionIdentifier = input.revisionId ?? revisionId(randomBytes(16))
  const plaintextChunks = input.content === null ? [] : chunkContent(input.content, chunkSize)
  const chunkCountForAad = Math.max(plaintextChunks.length, 1)
  const cipher = new RevisionCipher()
  const metadata: RevisionMetadata = {
    normalizedPath: input.normalizedPath,
    parents: input.parents ?? [],
    tombstone: input.content === null,
    contentType: input.contentType,
    totalPlaintextLength: input.content?.byteLength ?? 0,
    createdAt: input.createdAt,
  }
  const aadBase = {
    protocolGeneration: CIPHER_SUITE.protocolGeneration,
    suite: CIPHER_SUITE,
    vaultId: input.device.vaultId,
    epochId: input.device.epoch.body.epochId,
    fileId: fileIdentifier,
    revisionId: revisionIdentifier,
    operationType: OperationType.Revision,
    chunkCount: chunkCountForAad,
  } as const
  const encryptedMetadata = await cipher.encrypt(
    encodeRevisionMetadata(metadata),
    encodeAssociatedData({
      ...aadBase,
      objectKind: "revision-metadata",
      chunkIndex: 0,
    }),
  )

  const blobs: EncryptedBlob[] = []
  const chunks = []
  for (let index = 0; index < plaintextChunks.length; index += 1) {
    const plaintext = plaintextChunks[index]
    if (plaintext === undefined)
      throw new CryptoError("CHUNK_MISSING", "Internal chunk indexing failed")
    const encrypted = await cipher.encrypt(
      plaintext,
      encodeAssociatedData({
        ...aadBase,
        objectKind: "content-chunk",
        chunkIndex: index,
      }),
    )
    const blobIdentifier = blobId(randomBytes(16))
    blobs.push({ blobId: blobIdentifier, ciphertext: encrypted.ciphertext })
    chunks.push({
      blobId: blobIdentifier,
      chunkIndex: index,
      plaintextLength: plaintext.byteLength,
      nonce: encrypted.nonce,
    })
  }

  const body: RevisionOperation = {
    type: "revision",
    operationId: operationId(randomBytes(16)),
    vaultId: input.device.vaultId,
    epochId: input.device.epoch.body.epochId,
    authorDeviceId: input.device.deviceId,
    fileId: fileIdentifier,
    revisionId: revisionIdentifier,
    wrappedRevisionKey: await wrapRevisionKey(
      input.device.vaultEpochKey,
      input.device.vaultId,
      input.device.epoch.body.epochId,
      revisionIdentifier,
      cipher.key,
    ),
    metadataNonce: encryptedMetadata.nonce,
    encryptedMetadata: encryptedMetadata.ciphertext,
    chunks,
    suite: CIPHER_SUITE,
  }
  const operation = signOperation(body, input.device.signingPrivateKey)
  return { operation, operationBytes: encodeOperation(operation), blobs }
}

export interface DecryptFileRevisionInput {
  readonly operation: SignedOperation | Uint8Array
  readonly epochKey: DeviceKeyBundle["vaultEpochKey"]
  readonly authorCertificate: DeviceCertificate
  readonly loadBlob: (blobId: BlobId) => Promise<Uint8Array>
}

export interface DecryptedFileRevision {
  readonly operation: RevisionOperation
  readonly metadata: RevisionMetadata
  readonly content: Uint8Array | null
}

export async function decryptFileRevision(
  input: DecryptFileRevisionInput,
): Promise<DecryptedFileRevision> {
  const signed =
    input.operation instanceof Uint8Array ? decodeOperation(input.operation) : input.operation
  if (signed.body.type !== OperationType.Revision) {
    throw new CryptoError("NOT_A_REVISION", "Operation does not contain a file revision")
  }
  if (!verifyOperation(signed, input.authorCertificate)) {
    throw new AuthenticationError("Revision operation signature is invalid")
  }
  if (!input.authorCertificate.body.permissions.includes(Permission.Write)) {
    throw new AuthorizationError("Revision author did not have write permission")
  }
  if (!bytesEqual(signed.body.epochId, input.authorCertificate.body.epochId)) {
    throw new AuthorizationError("Revision author certificate does not authorize this epoch")
  }

  const key = await unwrapRevisionKey(
    input.epochKey,
    signed.body.vaultId,
    signed.body.epochId,
    signed.body.revisionId,
    signed.body.wrappedRevisionKey,
  )
  const chunkCountForAad = Math.max(signed.body.chunks.length, 1)
  const aadBase = {
    protocolGeneration: CIPHER_SUITE.protocolGeneration,
    suite: CIPHER_SUITE,
    vaultId: signed.body.vaultId,
    epochId: signed.body.epochId,
    fileId: signed.body.fileId,
    revisionId: signed.body.revisionId,
    operationType: OperationType.Revision,
    chunkCount: chunkCountForAad,
  } as const
  const metadataBytes = await aesGcmDecrypt(
    key,
    signed.body.encryptedMetadata,
    encodeAssociatedData({ ...aadBase, objectKind: "revision-metadata", chunkIndex: 0 }),
    signed.body.metadataNonce,
  )
  const metadata = decodeRevisionMetadata(metadataBytes)
  if (metadata.tombstone && signed.body.chunks.length !== 0) {
    throw new AuthenticationError("Tombstone revision references content chunks")
  }

  const plaintextChunks = await Promise.all(
    signed.body.chunks.map(async (chunk, index) => {
      const ciphertext = await input.loadBlob(chunk.blobId)
      const plaintext = await aesGcmDecrypt(
        key,
        ciphertext,
        encodeAssociatedData({ ...aadBase, objectKind: "content-chunk", chunkIndex: index }),
        chunk.nonce,
      )
      if (plaintext.byteLength !== chunk.plaintextLength) {
        throw new AuthenticationError("Decrypted chunk length does not match its signed descriptor")
      }
      return plaintext
    }),
  )
  const total = plaintextChunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  if (total !== metadata.totalPlaintextLength) {
    throw new AuthenticationError("Revision plaintext length does not match encrypted metadata")
  }
  if (metadata.tombstone) return { operation: signed.body, metadata, content: null }

  const content = new Uint8Array(total)
  let offset = 0
  for (const chunk of plaintextChunks) {
    content.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { operation: signed.body, metadata, content }
}
