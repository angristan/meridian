import {
  type BlobId,
  blobId,
  CIPHER_SUITE,
  type DeviceCertificate,
  decodeOperation,
  decodeRevisionMetadata,
  encodeAssociatedData,
  encodeOperation,
  encodeRevisionMetadata,
  type FileId,
  fileId,
  type OperationId,
  OperationType,
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
const BLOB_TRANSFER_CONCURRENCY = 4

export interface EncryptFileRevisionInput {
  readonly device: DeviceKeyBundle
  readonly operationId: OperationId
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
    operationId: input.operationId,
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

export interface InspectFileRevisionInput {
  readonly operation: SignedOperation | Uint8Array
  readonly epochKey: DeviceKeyBundle["vaultEpochKey"]
  readonly authorCertificate: DeviceCertificate
  readonly maximumPlaintextBytes?: number
}

export interface DecryptFileRevisionInput extends InspectFileRevisionInput {
  readonly loadBlob: (blobId: BlobId) => Promise<Uint8Array>
}

export interface InspectedFileRevision {
  readonly operation: RevisionOperation
  readonly metadata: RevisionMetadata
  readonly plaintextBytes: number
}

export interface DecryptedFileRevision extends InspectedFileRevision {
  readonly content: Uint8Array | null
}

export async function inspectFileRevision(
  input: InspectFileRevisionInput,
): Promise<InspectedFileRevision> {
  const prepared = await prepareFileRevision(input)
  return {
    operation: prepared.operation,
    metadata: prepared.metadata,
    plaintextBytes: prepared.plaintextBytes,
  }
}

export async function decryptFileRevision(
  input: DecryptFileRevisionInput,
): Promise<DecryptedFileRevision> {
  const prepared = await prepareFileRevision(input)
  const plaintextChunks = await mapConcurrently(
    prepared.operation.chunks,
    BLOB_TRANSFER_CONCURRENCY,
    async (chunk, index) => {
      const ciphertext = await input.loadBlob(chunk.blobId)
      const plaintext = await aesGcmDecrypt(
        prepared.key,
        ciphertext,
        encodeAssociatedData({
          ...prepared.aadBase,
          objectKind: "content-chunk",
          chunkIndex: index,
        }),
        chunk.nonce,
      )
      if (plaintext.byteLength !== chunk.plaintextLength) {
        throw new AuthenticationError("Decrypted chunk length does not match its signed descriptor")
      }
      return plaintext
    },
  )
  const total = plaintextChunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  if (total !== prepared.plaintextBytes) {
    throw new AuthenticationError("Revision plaintext length does not match encrypted metadata")
  }
  if (prepared.metadata.tombstone) return { ...preparedResult(prepared), content: null }

  const content = new Uint8Array(total)
  let offset = 0
  for (const chunk of plaintextChunks) {
    content.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { ...preparedResult(prepared), content }
}

async function mapConcurrently<Input, Output>(
  inputs: readonly Input[],
  concurrency: number,
  transform: (input: Input, index: number) => Promise<Output>,
): Promise<Output[]> {
  const outputs = new Array<Output>(inputs.length)
  let nextIndex = 0
  let failed = false
  let failure: unknown

  const worker = async () => {
    while (!failed) {
      const index = nextIndex
      nextIndex += 1
      const input = inputs[index]
      if (input === undefined) return
      try {
        outputs[index] = await transform(input, index)
      } catch (error) {
        failed = true
        failure = error
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, inputs.length) }, async () => worker()),
  )
  if (failed) throw failure
  return outputs
}

async function prepareFileRevision(input: InspectFileRevisionInput) {
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
  const maximumPlaintextBytes = input.maximumPlaintextBytes ?? Number.MAX_SAFE_INTEGER
  if (!Number.isSafeInteger(maximumPlaintextBytes) || maximumPlaintextBytes < 0) {
    throw new RangeError("Maximum revision plaintext size must be a non-negative safe integer")
  }
  let plaintextBytes = 0
  for (const chunk of signed.body.chunks) {
    if (chunk.plaintextLength > maximumPlaintextBytes - plaintextBytes) {
      throw new RangeError("Revision plaintext exceeds the configured size limit")
    }
    plaintextBytes += chunk.plaintextLength
  }

  const key = await unwrapRevisionKey(
    input.epochKey,
    signed.body.vaultId,
    signed.body.epochId,
    signed.body.revisionId,
    signed.body.wrappedRevisionKey,
  )
  const aadBase = {
    protocolGeneration: CIPHER_SUITE.protocolGeneration,
    suite: CIPHER_SUITE,
    vaultId: signed.body.vaultId,
    epochId: signed.body.epochId,
    fileId: signed.body.fileId,
    revisionId: signed.body.revisionId,
    operationType: OperationType.Revision,
    chunkCount: Math.max(signed.body.chunks.length, 1),
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
  if (metadata.totalPlaintextLength !== plaintextBytes) {
    throw new AuthenticationError("Revision plaintext length does not match encrypted metadata")
  }
  return { operation: signed.body, metadata, plaintextBytes, key, aadBase }
}

function preparedResult(prepared: Awaited<ReturnType<typeof prepareFileRevision>>) {
  return {
    operation: prepared.operation,
    metadata: prepared.metadata,
    plaintextBytes: prepared.plaintextBytes,
  }
}
