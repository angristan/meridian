export const PROTOCOL_GENERATION = 1 as const

/** RFC 9180 and IANA identifiers are numeric; application algorithms use stable names. */
export const CIPHER_SUITE = Object.freeze({
  protocolGeneration: PROTOCOL_GENERATION,
  encoding: "deterministic-cbor-rfc8949-v1",
  kem: 0x0020,
  kdf: 0x0001,
  aead: 0x0002,
  keyWrap: "A256KW",
  signature: "Ed25519",
  hash: "SHA-256",
} as const)

export type CipherSuite = typeof CIPHER_SUITE

export const Domain = Object.freeze({
  AssociatedData: "meridian/v1/aad",
  Certificate: "meridian/v1/device-certificate",
  Checkpoint: "meridian/v1/checkpoint",
  Epoch: "meridian/v1/epoch",
  LogEntry: "meridian/v1/log-entry",
  Operation: "meridian/v1/operation",
  PairingInfo: "meridian/v1/pairing-info",
  PairingTransfer: "meridian/v1/pairing-transfer",
  RecoveryPackage: "meridian/v1/recovery-package",
} as const)

export const KdfLabel = Object.freeze({
  RecoverySigningSeed: "meridian/v1/kdf/recovery-signing-seed",
  RecoveryEncryptionKey: "meridian/v1/kdf/recovery-encryption-key",
  RevisionKek: "meridian/v1/kdf/revision-kek",
} as const)

export const OperationType = Object.freeze({
  Revision: "revision",
  DeviceRevocation: "device-revocation",
  EpochTransition: "epoch-transition",
} as const)

export type OperationType = (typeof OperationType)[keyof typeof OperationType]

export const Permission = Object.freeze({
  Read: "read",
  Write: "write",
  ManageDevices: "manage-devices",
  RotateEpoch: "rotate-epoch",
} as const)

export type Permission = (typeof Permission)[keyof typeof Permission]

export const ZERO_HASH = new Uint8Array(32)
export const MAX_SAFE_CURSOR = Number.MAX_SAFE_INTEGER
