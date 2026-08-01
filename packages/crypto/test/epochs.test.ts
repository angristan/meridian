import { bytesEqual, decodeOperation, encodeOperation, hashBytes } from "@meridian/protocol"
import { describe, expect, it } from "vitest"
import {
  applyEpochTransition,
  createFirstDeviceClaimBundle,
  deserializeEncryptedRecoveryPackage,
  prepareEpochTransition,
  recoverDeviceFromPackage,
} from "../src/index.js"

const hash = (fill: number) => hashBytes(new Uint8Array(32).fill(fill))

describe("epoch lifecycle", () => {
  it("rotates an active device and advances public-key recovery state", async () => {
    const initial = await createFirstDeviceClaimBundle()
    const prepared = await prepareEpochTransition({
      device: initial.device,
      recipients: [
        {
          deviceId: initial.device.deviceId,
          hpkePublicKey: initial.device.hpkePublicKey,
        },
      ],
      recoverySigningPublicKey: initial.recoveryPublicKey,
      recoveryStateId: hash(1),
      checkpointAuthorizationChain: [initial.device.certificate],
      reason: "migration",
    })
    const operation = decodeOperation(encodeOperation(prepared.operation))
    const rotated = await applyEpochTransition({
      device: initial.device,
      operation,
      authorCertificate: initial.device.certificate,
      cursor: 1,
      logHash: hash(2),
    })

    expect(rotated.epoch.body.sequence).toBe(1)
    expect(rotated.epochKeys).toHaveLength(2)
    expect(rotated.epochActivatedAtCursor).toBe(1)
    expect(rotated.requiredTransitionOperationId).toBeUndefined()
    expect(bytesEqual(rotated.vaultEpochKey, initial.device.vaultEpochKey)).toBe(false)

    if (operation.body.type !== "epoch-transition") throw new Error("Expected epoch transition")
    const recoveryPackage = deserializeEncryptedRecoveryPackage(
      operation.body.encryptedRecoveryPackage,
    )
    expect(recoveryPackage.packageVersion).toBe(2)
    const recovered = await recoverDeviceFromPackage(initial.recoveryCode, recoveryPackage)
    expect(recovered.device.epoch.body.sequence).toBe(2)
    expect(recovered.device.epochKeys).toHaveLength(3)
    expect(
      bytesEqual(
        recovered.device.requiredTransitionOperationId ?? new Uint8Array(),
        operation.body.operationId,
      ),
    ).toBe(true)
  })

  it("rejects a transition key package intended for another device", async () => {
    const [initial, other] = await Promise.all([
      createFirstDeviceClaimBundle(),
      createFirstDeviceClaimBundle(),
    ])
    const prepared = await prepareEpochTransition({
      device: initial.device,
      recipients: [
        {
          deviceId: initial.device.deviceId,
          hpkePublicKey: other.device.hpkePublicKey,
        },
      ],
      recoverySigningPublicKey: initial.recoveryPublicKey,
      recoveryStateId: hash(3),
      checkpointAuthorizationChain: [initial.device.certificate],
      reason: "scheduled",
    })

    await expect(
      applyEpochTransition({
        device: initial.device,
        operation: prepared.operation,
        authorCertificate: initial.device.certificate,
        cursor: 1,
        logHash: hash(4),
      }),
    ).rejects.toThrow()
  })

  it("rejects same-sequence epoch forks", async () => {
    const initial = await createFirstDeviceClaimBundle()
    const first = await prepareEpochTransition({
      device: initial.device,
      recipients: [
        {
          deviceId: initial.device.deviceId,
          hpkePublicKey: initial.device.hpkePublicKey,
        },
      ],
      recoverySigningPublicKey: initial.recoveryPublicKey,
      recoveryStateId: hash(5),
      checkpointAuthorizationChain: [initial.device.certificate],
      reason: "migration",
    })
    const second = await prepareEpochTransition({
      device: initial.device,
      recipients: [
        {
          deviceId: initial.device.deviceId,
          hpkePublicKey: initial.device.hpkePublicKey,
        },
      ],
      recoverySigningPublicKey: initial.recoveryPublicKey,
      recoveryStateId: hash(5),
      checkpointAuthorizationChain: [initial.device.certificate],
      reason: "migration",
    })
    const rotated = await applyEpochTransition({
      device: initial.device,
      operation: first.operation,
      authorCertificate: initial.device.certificate,
      cursor: 1,
      logHash: hash(6),
    })

    await expect(
      applyEpochTransition({
        device: rotated,
        operation: second.operation,
        authorCertificate: initial.device.certificate,
        cursor: 1,
        logHash: hash(7),
      }),
    ).rejects.toThrow(/conflicts at the current sequence/)
  })
})
