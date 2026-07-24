import {
  type AuthChallenge,
  bytesEqual,
  bytesToHex,
  encodeDeviceCertificate,
  pairingId,
} from "@meridian/protocol"
import { describe, expect, it } from "vitest"
import {
  authChallengeSigningBytes,
  consumePairingEpochPackage,
  createFirstDeviceClaimBundle,
  createPairingDeviceRequest,
  createPendingPairingDevice,
  decryptFileRevision,
  decryptRecoveryPackage,
  deriveRecoveryKeys,
  deserializeDeviceKeyBundle,
  deserializeEncryptedRecoveryPackage,
  deserializePairingPackage,
  deviceEpochKey,
  encryptFileRevision,
  parseRecoveryCode,
  preparePairingEpochPackage,
  recoverDeviceFromPackage,
  recoveryClaimSigningBytes,
  serializeDeviceKeyBundle,
  serializeEncryptedRecoveryPackage,
  serializePairingPackage,
  signAuthChallenge,
  signRecoveryClaim,
  verify,
} from "../src/index.js"

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

describe("plugin-facing cryptography workflows", () => {
  it("creates, serializes, authenticates, and recovers a first device", async () => {
    const claim = await createFirstDeviceClaimBundle()
    const restored = deserializeDeviceKeyBundle(serializeDeviceKeyBundle(claim.device))
    expect(bytesEqual(restored.vaultEpochKey, claim.device.vaultEpochKey)).toBe(true)

    const challenge: AuthChallenge = {
      challengeId: "challenge-1",
      vaultId: claim.device.vaultId,
      deviceId: claim.device.deviceId,
      challenge: new Uint8Array(32).fill(9),
      expiresAt: Date.now() + 60_000,
    }
    const signature = signAuthChallenge(challenge, restored)
    expect(verify(authChallengeSigningBytes(challenge), signature, restored.signingPublicKey)).toBe(
      true,
    )

    const seed = await parseRecoveryCode(claim.recoveryCode)
    const keys = await deriveRecoveryKeys(seed)
    const transportedPackage = deserializeEncryptedRecoveryPackage(
      serializeEncryptedRecoveryPackage(claim.encryptedRecoveryPackage),
    )
    const recovered = await decryptRecoveryPackage(transportedPackage, keys.encryptionKey)
    expect(bytesEqual(recovered.vaultEpochKey, claim.device.vaultEpochKey)).toBe(true)

    const replacement = await recoverDeviceFromPackage(claim.recoveryCode, transportedPackage)
    expect(bytesEqual(replacement.device.vaultEpochKey, claim.device.vaultEpochKey)).toBe(false)
    expect(
      bytesEqual(
        deviceEpochKey(replacement.device, claim.device.epoch.body.epochId),
        claim.device.vaultEpochKey,
      ),
    ).toBe(true)
    expect(replacement.device.epoch.body.sequence).toBe(claim.device.epoch.body.sequence + 1)
    expect(bytesEqual(replacement.device.vaultId, claim.device.vaultId)).toBe(true)
    expect(bytesEqual(replacement.device.deviceId, claim.device.deviceId)).toBe(false)
    const recoveryClaim = {
      challengeId: "recovery-challenge-1",
      challenge: new Uint8Array(32).fill(7),
      vaultId: replacement.device.vaultId,
      deviceId: replacement.device.deviceId,
      signingPublicKey: replacement.device.signingPublicKey,
      hpkePublicKey: replacement.device.hpkePublicKey,
      certificate: encodeDeviceCertificate(replacement.device.certificate),
      encryptedRecoveryPackage: serializeEncryptedRecoveryPackage(
        replacement.encryptedRecoveryPackage,
      ),
    }
    const recoveryProof = await signRecoveryClaim(claim.recoveryCode, recoveryClaim)
    expect(
      verify(recoveryClaimSigningBytes(recoveryClaim), recoveryProof, claim.recoveryPublicKey),
    ).toBe(true)

    const last = claim.recoveryCode.at(-1)
    const tamperedCode = `${claim.recoveryCode.slice(0, -1)}${last === "A" ? "B" : "A"}`
    await expect(parseRecoveryCode(tamperedCode)).rejects.toThrow()
  })

  it("encrypts and decrypts signed chunked file revisions", async () => {
    const claim = await createFirstDeviceClaimBundle()
    const plaintext = textEncoder.encode("offline revisions survive")
    const encrypted = await encryptFileRevision({
      device: claim.device,
      normalizedPath: "Notes/Café.md",
      content: plaintext,
      contentType: "utf8-text",
      createdAt: 1_700_000_000_000,
      chunkSize: 5,
    })
    expect(encrypted.blobs.length).toBeGreaterThan(1)
    const blobs = new Map(encrypted.blobs.map((blob) => [bytesToHex(blob.blobId), blob.ciphertext]))
    const decrypted = await decryptFileRevision({
      operation: encrypted.operationBytes,
      epochKey: claim.device.vaultEpochKey,
      authorCertificate: claim.device.certificate,
      loadBlob: async (id) => {
        const value = blobs.get(bytesToHex(id))
        if (value === undefined) throw new Error("missing test blob")
        return value
      },
    })
    expect(decrypted.metadata.normalizedPath).toBe("Notes/Café.md")
    expect(textDecoder.decode(decrypted.content ?? new Uint8Array())).toBe(
      "offline revisions survive",
    )
    const replacement = await recoverDeviceFromPackage(
      claim.recoveryCode,
      claim.encryptedRecoveryPackage,
    )
    const recoveredHistory = await decryptFileRevision({
      operation: encrypted.operationBytes,
      epochKey: deviceEpochKey(replacement.device, encrypted.operation.body.epochId),
      authorCertificate: claim.device.certificate,
      loadBlob: async (id) => blobs.get(bytesToHex(id)) ?? new Uint8Array(),
    })
    expect(textDecoder.decode(recoveredHistory.content ?? new Uint8Array())).toBe(
      "offline revisions survive",
    )

    const first = encrypted.blobs[0]
    if (first === undefined) throw new Error("expected a test blob")
    const tampered = new Uint8Array(first.ciphertext)
    tampered[0] = (tampered[0] ?? 0) ^ 1
    blobs.set(bytesToHex(first.blobId), tampered)
    await expect(
      decryptFileRevision({
        operation: encrypted.operation,
        epochKey: claim.device.vaultEpochKey,
        authorCertificate: claim.device.certificate,
        loadBlob: async (id) => blobs.get(bytesToHex(id)) ?? new Uint8Array(),
      }),
    ).rejects.toThrow(/authentication failed/)
  })

  it("prepares, serializes, verifies, and consumes a pairing epoch package", async () => {
    const first = await createFirstDeviceClaimBundle()
    const pending = await createPendingPairingDevice()
    const request = createPairingDeviceRequest(
      pairingId(new Uint8Array(16).fill(8)),
      first.device.vaultId,
      pending,
    )
    const prepared = await preparePairingEpochPackage({
      approver: first.device,
      request,
      recoveryPublicKey: first.recoveryPublicKey,
      authorizationChain: [first.device.certificate],
      expiresAt: Date.now() + 60_000,
    })
    const transported = deserializePairingPackage(serializePairingPackage(prepared.package))
    const paired = await consumePairingEpochPackage({
      pending,
      package: transported,
      confirmedVerificationPhrase: prepared.verificationPhrase,
      now: Date.now(),
    })
    expect(bytesEqual(paired.vaultEpochKey, first.device.vaultEpochKey)).toBe(true)
    expect(bytesEqual(paired.deviceId, pending.deviceId)).toBe(true)
    expect(() => deserializeDeviceKeyBundle(serializeDeviceKeyBundle(paired))).not.toThrow()
  })
})
