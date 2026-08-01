import { sign } from "@meridian/crypto"
import { retentionAcknowledgementSigningBytes } from "@meridian/protocol"
import type { DeviceKeyMaterial, RetentionAcknowledgement, TrustedCheckpoint } from "../model"
import { toBase64Url } from "../platform/bytes"
import { deviceBundle } from "./device-secret"

/** Signs the exact durable log and epoch this device has made readable locally. */
export async function createRetentionAcknowledgement(
  device: DeviceKeyMaterial,
  checkpoint: TrustedCheckpoint,
): Promise<RetentionAcknowledgement> {
  if (checkpoint.cursor < device.trustedCheckpoint.cursor) {
    throw new Error("Cannot acknowledge retention below the trusted device checkpoint")
  }
  const acknowledgement = {
    deviceId: device.deviceId,
    cursor: checkpoint.cursor,
    logHash: checkpoint.logHash,
    epochId: device.epochId,
    historyRetention: "forever" as const,
  }
  const signature = sign(
    retentionAcknowledgementSigningBytes({
      vaultId: device.vaultId,
      ...acknowledgement,
    }),
    deviceBundle(device).signingPrivateKey,
  )
  return { ...acknowledgement, signature: toBase64Url(signature) }
}
