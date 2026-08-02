import {
  decryptFileRevision,
  deviceEpochKey,
  encryptFileRevision,
  inspectFileRevision,
  sign,
  verify,
} from "@meridian/crypto"
import {
  decodeOperation,
  ed25519Signature,
  fileId,
  operationId,
  revisionId,
} from "@meridian/protocol"
import type {
  BlobTransferProgress,
  DecryptedRevision,
  DeviceKeyMaterial,
  EncryptedRevision,
  HistoryRevisionMetadata,
  RemoteOperation,
  RevisionDraft,
} from "../model"
import { fromBase64Url, toBase64Url } from "../platform/bytes"
import { deviceBundle, trustedAuthorCertificate } from "./device-secret"
import {
  parseFileWorkerOperation,
  type WorkerOperation,
  workerOperationSigningBytes,
} from "./worker-operation"

export async function encryptRevision(
  device: DeviceKeyMaterial,
  draft: RevisionDraft,
): Promise<EncryptedRevision> {
  const bundle = deviceBundle(device)
  const encrypted = await encryptFileRevision({
    device: bundle,
    operationId: operationId(fromBase64Url(draft.operationId)),
    normalizedPath: draft.path,
    content: draft.bytes ? new Uint8Array(draft.bytes) : null,
    contentType: isTextPath(draft.path) ? "utf8-text" : "binary",
    fileId: fileId(fromBase64Url(draft.fileId)),
    revisionId: revisionId(fromBase64Url(draft.revisionId)),
    parents: draft.parents.map((parent) => revisionId(fromBase64Url(parent))),
    createdAt: Date.now(),
    chunkSize: draft.chunkSize,
  })
  const type =
    draft.action === "delete" ? "tombstone" : draft.action === "restore" ? "restore" : "revision"
  const unsigned: Omit<WorkerOperation, "signature"> = {
    operationId: draft.operationId,
    authorDeviceId: device.deviceId,
    epochId: toBase64Url(bundle.epoch.body.epochId),
    type,
    envelope: toBase64Url(encrypted.operationBytes),
  }
  const signature = sign(workerOperationSigningBytes(unsigned), bundle.signingPrivateKey)
  return {
    envelope: { ...unsigned, signature: toBase64Url(signature) },
    blobs: encrypted.blobs.map((blob, chunkIndex) => ({
      blobId: toBase64Url(blob.blobId),
      bytes: copyBuffer(blob.ciphertext),
      chunkIndex,
    })),
  }
}

export async function inspectRevision(
  device: DeviceKeyMaterial,
  operation: RemoteOperation,
  maximumPlaintextBytes: number,
): Promise<HistoryRevisionMetadata> {
  const verified = verifiedRevision(device, operation)
  const inspected = await inspectFileRevision({
    operation: verified.signedOperation,
    epochKey: deviceEpochKey(verified.bundle, verified.revisionBody.epochId),
    authorCertificate: verified.authorCertificate,
    maximumPlaintextBytes,
  })
  return revisionMetadata(verified.wire, inspected)
}

export async function decryptRevision(
  device: DeviceKeyMaterial,
  operation: RemoteOperation,
  maximumPlaintextBytes: number,
  loadBlob: (blobId: string) => Promise<ArrayBuffer>,
  onBlobProgress?: (progress: BlobTransferProgress) => void,
): Promise<DecryptedRevision> {
  const verified = verifiedRevision(device, operation)
  const { bundle, wire, authorCertificate, signedOperation, revisionBody } = verified
  const chunkLengths = new Map(
    revisionBody.chunks.map((chunk) => [toBase64Url(chunk.blobId), chunk.plaintextLength]),
  )
  let totalBytes = 0
  for (const chunk of revisionBody.chunks) {
    if (chunk.plaintextLength > maximumPlaintextBytes - totalBytes) {
      throw new Error("Revision plaintext exceeds the configured mobile-safe file size limit")
    }
    totalBytes += chunk.plaintextLength
  }
  let completedChunks = 0
  let transferredBytes = 0
  const decrypted = await decryptFileRevision({
    operation: signedOperation,
    epochKey: deviceEpochKey(bundle, revisionBody.epochId),
    authorCertificate,
    maximumPlaintextBytes,
    loadBlob: async (blobId) => {
      const encodedBlobId = toBase64Url(blobId)
      const bytes = await loadBlob(encodedBlobId)
      completedChunks += 1
      transferredBytes += chunkLengths.get(encodedBlobId) ?? bytes.byteLength
      onBlobProgress?.({
        completedChunks,
        totalChunks: revisionBody.chunks.length,
        transferredBytes,
        totalBytes,
      })
      return new Uint8Array(bytes)
    },
  })
  if (decrypted.metadata.tombstone !== (wire.type === "tombstone")) {
    throw new Error("Worker file operation type does not match its signed revision")
  }
  return {
    ...revisionMetadata(wire, decrypted),
    bytes: decrypted.content ? copyBuffer(decrypted.content) : null,
  }
}

function verifiedRevision(device: DeviceKeyMaterial, operation: RemoteOperation) {
  const bundle = deviceBundle(device)
  const wire = parseFileWorkerOperation(operation.envelope)
  const authorCertificate =
    wire.authorDeviceId === device.deviceId
      ? bundle.certificate
      : trustedAuthorCertificate(device, operation)
  const unsigned: Omit<WorkerOperation, "signature"> = {
    operationId: wire.operationId,
    authorDeviceId: wire.authorDeviceId,
    epochId: wire.epochId,
    type: wire.type,
    envelope: wire.envelope,
  }
  if (
    !verify(
      workerOperationSigningBytes(unsigned),
      ed25519Signature(fromBase64Url(wire.signature)),
      authorCertificate.body.signingPublicKey,
    )
  ) {
    throw new Error("Worker file operation signature is invalid")
  }
  const signedOperation = decodeOperation(fromBase64Url(wire.envelope))
  if (signedOperation.body.type !== "revision") {
    throw new Error("Worker file operation does not contain an encrypted revision")
  }
  if (
    toBase64Url(signedOperation.body.authorDeviceId) !== wire.authorDeviceId ||
    toBase64Url(signedOperation.body.epochId) !== wire.epochId
  ) {
    throw new Error("Worker file operation does not match its signed revision")
  }
  return {
    bundle,
    wire,
    authorCertificate,
    signedOperation,
    revisionBody: signedOperation.body,
  }
}

function revisionMetadata(
  wire: WorkerOperation,
  revision: Awaited<ReturnType<typeof inspectFileRevision>>,
): HistoryRevisionMetadata {
  return {
    revisionId: toBase64Url(revision.operation.revisionId),
    operationId: wire.operationId,
    fileId: toBase64Url(revision.operation.fileId),
    action: wire.type === "tombstone" ? "delete" : wire.type === "restore" ? "restore" : "upsert",
    path: revision.metadata.normalizedPath,
    previousPath: null,
    parents: revision.metadata.parents.map(toBase64Url),
    authorDeviceId: wire.authorDeviceId,
    createdAt: revision.metadata.createdAt,
    byteLength: revision.plaintextBytes,
    isText: revision.metadata.contentType === "utf8-text",
  }
}

function copyBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength)
  copy.set(value)
  return copy.buffer
}

function isTextPath(path: string): boolean {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLocaleLowerCase("en-US")
  return ["md", "txt", "css", "json", "canvas", "csv", "html", "xml", "yaml", "yml"].includes(
    extension,
  )
}
