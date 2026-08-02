const brand: unique symbol = Symbol("meridian.protocol.bytes.brand")

export const IDENTIFIER_BYTES = 16

export type BrandedBytes<Name extends string> = Uint8Array & {
  readonly [brand]: Name
}

export type VaultId = BrandedBytes<"VaultId">
export type DeviceId = BrandedBytes<"DeviceId">
export type FileId = BrandedBytes<"FileId">
export type RevisionId = BrandedBytes<"RevisionId">
export type OperationId = BrandedBytes<"OperationId">
export type EpochId = BrandedBytes<"EpochId">
export type BlobId = BrandedBytes<"BlobId">
export type CertificateId = BrandedBytes<"CertificateId">
export type PairingId = BrandedBytes<"PairingId">
export type RecoveryId = BrandedBytes<"RecoveryId">
export type Hash = BrandedBytes<"Hash">
export type Ed25519PublicKey = BrandedBytes<"Ed25519PublicKey">
export type Ed25519PrivateKey = BrandedBytes<"Ed25519PrivateKey">
export type Ed25519Signature = BrandedBytes<"Ed25519Signature">
export type X25519PublicKey = BrandedBytes<"X25519PublicKey">
export type X25519PrivateKey = BrandedBytes<"X25519PrivateKey">
export type RecoverySeed = BrandedBytes<"RecoverySeed">
export type VaultEpochKey = BrandedBytes<"VaultEpochKey">
export type RevisionKey = BrandedBytes<"RevisionKey">
export type Nonce = BrandedBytes<"Nonce">
export type WrappedRevisionKey = BrandedBytes<"WrappedRevisionKey">

function checkedBytes<Name extends string>(value: Uint8Array, length: number, name: Name) {
  if (!(value instanceof Uint8Array) || value.byteLength !== length) {
    throw new RangeError(`${name} must contain exactly ${length} bytes`)
  }

  return new Uint8Array(value) as BrandedBytes<Name>
}

export const idBytes = <Name extends string>(value: Uint8Array, name: Name) =>
  checkedBytes(value, IDENTIFIER_BYTES, name)

export const hashBytes = (value: Uint8Array) => checkedBytes(value, 32, "Hash") as Hash
export const ed25519PublicKey = (value: Uint8Array) =>
  checkedBytes(value, 32, "Ed25519PublicKey") as Ed25519PublicKey
export const ed25519PrivateKey = (value: Uint8Array) =>
  checkedBytes(value, 32, "Ed25519PrivateKey") as Ed25519PrivateKey
export const ed25519Signature = (value: Uint8Array) =>
  checkedBytes(value, 64, "Ed25519Signature") as Ed25519Signature
export const x25519PublicKey = (value: Uint8Array) =>
  checkedBytes(value, 32, "X25519PublicKey") as X25519PublicKey
export const x25519PrivateKey = (value: Uint8Array) =>
  checkedBytes(value, 32, "X25519PrivateKey") as X25519PrivateKey
export const recoverySeed = (value: Uint8Array) =>
  checkedBytes(value, 32, "RecoverySeed") as RecoverySeed
export const vaultEpochKey = (value: Uint8Array) =>
  checkedBytes(value, 32, "VaultEpochKey") as VaultEpochKey
export const revisionKey = (value: Uint8Array) =>
  checkedBytes(value, 32, "RevisionKey") as RevisionKey
export const nonce = (value: Uint8Array) => checkedBytes(value, 12, "Nonce") as Nonce
export const wrappedRevisionKey = (value: Uint8Array) =>
  checkedBytes(value, 40, "WrappedRevisionKey") as WrappedRevisionKey

export const vaultId = (value: Uint8Array) => idBytes(value, "VaultId") as VaultId
export const deviceId = (value: Uint8Array) => idBytes(value, "DeviceId") as DeviceId
export const fileId = (value: Uint8Array) => idBytes(value, "FileId") as FileId
export const revisionId = (value: Uint8Array) => idBytes(value, "RevisionId") as RevisionId
export const operationId = (value: Uint8Array) => idBytes(value, "OperationId") as OperationId
export const epochId = (value: Uint8Array) => idBytes(value, "EpochId") as EpochId
export const blobId = (value: Uint8Array) => idBytes(value, "BlobId") as BlobId
export const certificateId = (value: Uint8Array) => idBytes(value, "CertificateId") as CertificateId
export const pairingId = (value: Uint8Array) => idBytes(value, "PairingId") as PairingId
export const recoveryId = (value: Uint8Array) => idBytes(value, "RecoveryId") as RecoveryId

export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false

  let difference = 0
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0)
  }
  return difference === 0
}

export function bytesToHex(value: Uint8Array): string {
  let result = ""
  for (const byte of value) result += byte.toString(16).padStart(2, "0")
  return result
}

export function hexToBytes(value: string): Uint8Array {
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(value)) throw new TypeError("Invalid hexadecimal string")

  const result = new Uint8Array(value.length / 2)
  for (let index = 0; index < result.length; index += 1) {
    result[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16)
  }
  return result
}
