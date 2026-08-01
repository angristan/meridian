import {
  bytesEqual,
  CIPHER_SUITE,
  checkpointLogFormats,
  type DeviceCertificate,
  type DeviceId,
  decodeCanonical,
  type Ed25519PublicKey,
  type EpochTransitionOperation,
  encodeCanonical,
  epochId,
  epochSigningBytes,
  type Hash,
  type OperationId,
  operationId,
  Permission,
  type RecoveryState,
  type SignedOperation,
  vaultEpochKey,
  type X25519PublicKey,
} from "@meridian/protocol"
import {
  signCheckpoint,
  signEpochDeclaration,
  signOperation,
  verifyOperation,
} from "./authorization.js"
import { AuthorizationError, CryptoError } from "./errors.js"
import { hpkeOpen, hpkeSeal } from "./hpke.js"
import type { DeviceKeyBundle } from "./lifecycle.js"
import {
  encryptRecoveryPackageForPublicKey,
  serializeEncryptedRecoveryPackage,
} from "./recovery.js"
import { randomBytes } from "./runtime.js"
import { verify } from "./signatures.js"

export interface EpochRecipient {
  readonly deviceId: DeviceId
  readonly hpkePublicKey: X25519PublicKey
}

export interface PrepareEpochTransitionInput {
  readonly device: DeviceKeyBundle
  readonly recipients: readonly EpochRecipient[]
  readonly recoverySigningPublicKey: Ed25519PublicKey
  readonly recoveryStateId: Hash
  readonly checkpointAuthorizationChain: readonly DeviceCertificate[]
  readonly reason: "scheduled" | "revocation" | "migration"
}

export interface PreparedEpochTransition {
  readonly operation: SignedOperation & { readonly body: EpochTransitionOperation }
  readonly nextEpochId: ReturnType<typeof epochId>
}

export async function prepareEpochTransition(
  input: PrepareEpochTransitionInput,
): Promise<PreparedEpochTransition> {
  const { device } = input
  if (!device.certificate.body.permissions.includes(Permission.RotateEpoch)) {
    throw new AuthorizationError("Device cannot rotate vault epochs")
  }
  if (device.requiredTransitionOperationId !== undefined) {
    throw new CryptoError(
      "EPOCH_TRANSITION_PENDING",
      "Device must verify its required recovery transition before rotating again",
    )
  }
  if (device.epoch.body.sequence >= Number.MAX_SAFE_INTEGER) {
    throw new CryptoError("EPOCH_SEQUENCE_EXHAUSTED", "Epoch sequence cannot advance safely")
  }
  if (device.epochKeys.length >= 1024) {
    throw new CryptoError("EPOCH_KEYRING_FULL", "Device epoch keyring reached its safe bound")
  }
  if (input.recipients.length < 1 || input.recipients.length > 1024) {
    throw new CryptoError("INVALID_EPOCH_RECIPIENTS", "Epoch recipient list is invalid")
  }
  const recipientIds = input.recipients.map((recipient) => bytesKey(recipient.deviceId))
  if (new Set(recipientIds).size !== recipientIds.length) {
    throw new CryptoError("INVALID_EPOCH_RECIPIENTS", "Epoch recipients contain duplicates")
  }
  if (!recipientIds.includes(bytesKey(device.deviceId))) {
    throw new CryptoError("INVALID_EPOCH_RECIPIENTS", "Epoch recipients omit the rotating device")
  }

  const transitionOperationId = operationId(randomBytes(16))
  const nextEpochId = epochId(randomBytes(16))
  const nextEpochKey = vaultEpochKey(randomBytes(32))
  const declaration = signEpochDeclaration(
    {
      vaultId: device.vaultId,
      epochId: nextEpochId,
      sequence: device.epoch.body.sequence + 1,
      previousEpochId: device.epoch.body.epochId,
      suite: CIPHER_SUITE,
      createdBy: device.deviceId,
      reason: input.reason,
    },
    device.signingPrivateKey,
  )
  const keyPackages = await Promise.all(
    input.recipients.map(async (recipient) => ({
      recipientDeviceId: recipient.deviceId,
      transfer: await hpkeSeal(
        recipient.hpkePublicKey,
        encodeCanonical({
          vaultId: device.vaultId,
          operationId: transitionOperationId,
          previousEpochId: device.epoch.body.epochId,
          nextEpochId,
          recipientDeviceId: recipient.deviceId,
          vaultEpochKey: nextEpochKey,
        }),
        epochKeyPackageInfo(
          device.vaultId,
          transitionOperationId,
          device.checkpoint.body.cursor,
          device.checkpoint.body.logHash,
          nextEpochId,
          recipient.deviceId,
        ),
      ),
    })),
  )
  const recoveryState: RecoveryState = {
    vaultId: device.vaultId,
    epoch: declaration,
    vaultEpochKey: nextEpochKey,
    epochKeys: [...device.epochKeys, { epochId: nextEpochId, vaultEpochKey: nextEpochKey }],
    checkpoint: device.checkpoint,
    recoverySequence: declaration.body.sequence,
    requiredTransitionOperationId: transitionOperationId,
  }
  const encryptedRecoveryPackage = serializeEncryptedRecoveryPackage(
    await encryptRecoveryPackageForPublicKey(recoveryState, input.recoverySigningPublicKey, {
      deviceId: device.deviceId,
      signingPrivateKey: device.signingPrivateKey,
      authorizationChain: input.checkpointAuthorizationChain,
    }),
  )
  const body: EpochTransitionOperation = {
    type: "epoch-transition",
    operationId: transitionOperationId,
    vaultId: device.vaultId,
    epochId: device.epoch.body.epochId,
    authorDeviceId: device.deviceId,
    previousCursor: device.checkpoint.body.cursor,
    previousLogHash: device.checkpoint.body.logHash,
    declaration,
    keyPackages,
    previousRecoveryStateId: input.recoveryStateId,
    encryptedRecoveryPackage,
    suite: CIPHER_SUITE,
  }
  return {
    operation: signOperation(
      body,
      device.signingPrivateKey,
    ) as PreparedEpochTransition["operation"],
    nextEpochId,
  }
}

export interface ApplyEpochTransitionInput {
  readonly device: DeviceKeyBundle
  readonly operation: SignedOperation
  readonly authorCertificate: DeviceCertificate
  readonly cursor: number
  readonly logHash: Hash
}

export async function applyEpochTransition(
  input: ApplyEpochTransitionInput,
): Promise<DeviceKeyBundle> {
  const body = input.operation.body
  if (body.type !== "epoch-transition") {
    throw new CryptoError("INVALID_EPOCH_TRANSITION", "Operation is not an epoch transition")
  }
  if (!verifyOperation(input.operation, input.authorCertificate)) {
    throw new AuthorizationError("Epoch transition operation signature is invalid")
  }
  if (!input.authorCertificate.body.permissions.includes(Permission.RotateEpoch)) {
    throw new AuthorizationError("Epoch transition author cannot rotate vault epochs")
  }
  if (
    !bytesEqual(body.vaultId, input.device.vaultId) ||
    !bytesEqual(body.declaration.body.vaultId, input.device.vaultId) ||
    body.declaration.body.createdBy === "recovery" ||
    !bytesEqual(body.declaration.body.createdBy, body.authorDeviceId) ||
    !verify(
      epochSigningBytes(body.declaration.body),
      body.declaration.signature,
      input.authorCertificate.body.signingPublicKey,
    )
  ) {
    throw new AuthorizationError("Epoch declaration authorization is invalid")
  }
  const required = input.device.requiredTransitionOperationId
  if (required !== undefined && !bytesEqual(required, body.operationId)) {
    throw new CryptoError(
      "RECOVERY_TRANSITION_MISMATCH",
      "Recovery package requires a different epoch transition",
    )
  }

  const currentSequence = input.device.epoch.body.sequence
  const nextSequence = body.declaration.body.sequence
  if (nextSequence <= currentSequence) {
    if (
      nextSequence === currentSequence &&
      !bytesEqual(body.declaration.body.epochId, input.device.epoch.body.epochId)
    ) {
      throw new CryptoError("EPOCH_FORK", "Epoch transition conflicts at the current sequence")
    }
    const retained = input.device.epochKeys.some((entry) =>
      bytesEqual(entry.epochId, body.declaration.body.epochId),
    )
    if (
      required !== undefined &&
      !bytesEqual(
        input.device.epoch.body.previousEpochId ?? new Uint8Array(),
        body.declaration.body.epochId,
      )
    ) {
      throw new CryptoError(
        "RECOVERY_TRANSITION_MISMATCH",
        "Required transition is not the recovered epoch predecessor",
      )
    }
    if (!retained) {
      throw new CryptoError("EPOCH_KEY_MISSING", "Historical epoch transition key is not retained")
    }
    if (required === undefined) return input.device
    const { requiredTransitionOperationId: _required, ...clearedDevice } = input.device
    return clearedDevice
  }
  if (
    nextSequence !== currentSequence + 1 ||
    !bytesEqual(body.epochId, input.device.epoch.body.epochId) ||
    !bytesEqual(
      body.declaration.body.previousEpochId ?? new Uint8Array(),
      input.device.epoch.body.epochId,
    ) ||
    body.previousCursor !== input.device.checkpoint.body.cursor ||
    !bytesEqual(body.previousLogHash, input.device.checkpoint.body.logHash)
  ) {
    throw new CryptoError(
      "EPOCH_TRANSITION_CONFLICT",
      "Epoch transition is not the exact successor",
    )
  }
  const keyPackage = body.keyPackages.find((entry) =>
    bytesEqual(entry.recipientDeviceId, input.device.deviceId),
  )
  if (!keyPackage) {
    throw new CryptoError("EPOCH_RECIPIENT_MISSING", "Epoch transition omits this active device")
  }
  const plaintext = await hpkeOpen(
    input.device.hpkePrivateKey,
    keyPackage.transfer,
    epochKeyPackageInfo(
      input.device.vaultId,
      body.operationId,
      body.previousCursor,
      body.previousLogHash,
      body.declaration.body.epochId,
      input.device.deviceId,
    ),
  )
  const keyState = recoveryRecord(decodeCanonical(plaintext))
  if (
    Object.keys(keyState).sort().join("\0") !==
      "nextEpochId\0operationId\0previousEpochId\0recipientDeviceId\0vaultEpochKey\0vaultId" ||
    !isBytes(keyState.vaultId, 16) ||
    !isBytes(keyState.operationId, 16) ||
    !isBytes(keyState.previousEpochId, 16) ||
    !isBytes(keyState.nextEpochId, 16) ||
    !isBytes(keyState.recipientDeviceId, 16) ||
    !isBytes(keyState.vaultEpochKey, 32) ||
    !bytesEqual(keyState.vaultId, input.device.vaultId) ||
    !bytesEqual(keyState.operationId, body.operationId) ||
    !bytesEqual(keyState.previousEpochId, body.epochId) ||
    !bytesEqual(keyState.nextEpochId, body.declaration.body.epochId) ||
    !bytesEqual(keyState.recipientDeviceId, input.device.deviceId)
  ) {
    throw new CryptoError(
      "INVALID_EPOCH_KEY_PACKAGE",
      "Epoch key package does not match transition",
    )
  }
  const nextKey = vaultEpochKey(keyState.vaultEpochKey)
  const checkpoint = signCheckpoint(
    {
      vaultId: input.device.vaultId,
      epochId: body.declaration.body.epochId,
      cursor: input.cursor,
      logHash: input.logHash,
      signerDeviceId: input.device.deviceId,
      protocolGeneration: CIPHER_SUITE.protocolGeneration,
      ...checkpointLogFormats(input.device.checkpoint.body),
    },
    input.device.signingPrivateKey,
  )
  const { requiredTransitionOperationId: _required, ...currentDevice } = input.device
  return {
    ...currentDevice,
    version: 2,
    epoch: body.declaration,
    vaultEpochKey: nextKey,
    epochKeys: [
      ...input.device.epochKeys,
      { epochId: body.declaration.body.epochId, vaultEpochKey: nextKey },
    ],
    epochActivatedAtCursor: input.cursor,
    checkpoint,
  }
}

function epochKeyPackageInfo(
  vaultId: Uint8Array,
  operationId: OperationId,
  previousCursor: number,
  previousLogHash: Hash,
  nextEpochId: Uint8Array,
  recipientDeviceId: DeviceId,
): Uint8Array {
  return encodeCanonical({
    domain: "meridian/v1/epoch-key-package",
    vaultId,
    operationId,
    previousCursor,
    previousLogHash,
    nextEpochId,
    recipientDeviceId,
  })
}

function recoveryRecord(value: unknown): Record<string, Uint8Array> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value instanceof Uint8Array ||
    value instanceof Map
  ) {
    throw new CryptoError("INVALID_EPOCH_KEY_PACKAGE", "Epoch key package plaintext is invalid")
  }
  return value as Record<string, Uint8Array>
}

function isBytes(value: unknown, length: number): value is Uint8Array {
  return value instanceof Uint8Array && value.byteLength === length
}

function bytesKey(value: Uint8Array): string {
  return [...value].join(",")
}
