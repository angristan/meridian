import {
  type AuthChallenge,
  bytesEqual,
  bytesToHex,
  type CborValue,
  decodeCanonical,
  ed25519Signature,
  encodeCanonical,
  encodeDeviceCertificate,
  hashBytes,
  Permission,
  pairingId,
  recoveryId,
  vaultId,
} from "@meridian/protocol"
import { describe, expect, it } from "vitest"
import {
  authChallengeSigningBytes,
  computeRecoveryStateId,
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
  deserializePairingVerificationPreview,
  deviceEpochKey,
  encryptFileRevision,
  encryptRecoveryPackage,
  inspectPairingVerificationPreview,
  parseRecoveryCode,
  preparePairingEpochPackage,
  recoverDeviceFromPackage,
  recoveryClaimSigningBytes,
  serializeDeviceKeyBundle,
  serializeEncryptedRecoveryPackage,
  serializePairingPackage,
  serializePairingVerificationPreview,
  sha256,
  signAuthChallenge,
  signDeviceCertificate,
  signEpochDeclaration,
  signPairingVerificationPreview,
  signRecoveryClaim,
  verify,
  verifyPairingDeviceRequest,
} from "../src/index.js"

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

describe("plugin-facing cryptography workflows", () => {
  it("creates, serializes, authenticates, and recovers a first device", async () => {
    const claim = await createFirstDeviceClaimBundle()
    const serializedDevice = serializeDeviceKeyBundle(claim.device)
    const restored = deserializeDeviceKeyBundle(serializedDevice)
    expect(bytesEqual(restored.vaultEpochKey, claim.device.vaultEpochKey)).toBe(true)

    const serializedValue = decodeCanonical(serializedDevice) as Record<string, CborValue>
    const tamperedHpkePrivateKey = new Uint8Array(serializedValue.hpkePrivateKey as Uint8Array)
    tamperedHpkePrivateKey[1] = (tamperedHpkePrivateKey[1] ?? 0) ^ 1
    expect(() =>
      deserializeDeviceKeyBundle(
        encodeCanonical({ ...serializedValue, hpkePrivateKey: tamperedHpkePrivateKey }),
      ),
    ).toThrow(/HPKE keypair does not match/)

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

    const tamperedCheckpointSignature = new Uint8Array(transportedPackage.checkpoint.signature)
    tamperedCheckpointSignature[0] = (tamperedCheckpointSignature[0] ?? 0) ^ 1
    await expect(
      decryptRecoveryPackage(
        {
          ...transportedPackage,
          checkpoint: {
            ...transportedPackage.checkpoint,
            signature: ed25519Signature(tamperedCheckpointSignature),
          },
        },
        keys.encryptionKey,
      ),
    ).rejects.toThrow(/public commitment/)

    const substitutedVaultId = new Uint8Array(recovered.vaultId)
    substitutedVaultId[0] = (substitutedVaultId[0] ?? 0) ^ 1
    const inconsistentPackage = await encryptRecoveryPackage(
      {
        ...recovered,
        epoch: signEpochDeclaration(
          { ...recovered.epoch.body, vaultId: vaultId(substitutedVaultId) },
          keys.signingPrivateKey,
        ),
      },
      keys.encryptionKey,
    )
    await expect(decryptRecoveryPackage(inconsistentPackage, keys.encryptionKey)).rejects.toThrow(
      /internally inconsistent/,
    )

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
      claimVersion: 2 as const,
      recoveryId: recoveryId(new Uint8Array(16).fill(8)),
      previousRecoveryStateId: await computeRecoveryStateId(
        claim.device.vaultId,
        serializeEncryptedRecoveryPackage(transportedPackage),
      ),
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
    expect(
      verify(
        recoveryClaimSigningBytes({
          ...recoveryClaim,
          previousRecoveryStateId: hashBytes(new Uint8Array(32).fill(9)),
        }),
        recoveryProof,
        claim.recoveryPublicKey,
      ),
    ).toBe(false)

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
      maximumPlaintextBytes: plaintext.byteLength,
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

    let oversizedLoadCalls = 0
    await expect(
      decryptFileRevision({
        operation: encrypted.operationBytes,
        epochKey: claim.device.vaultEpochKey,
        authorCertificate: claim.device.certificate,
        maximumPlaintextBytes: plaintext.byteLength - 1,
        loadBlob: async () => {
          oversizedLoadCalls += 1
          return new Uint8Array()
        },
      }),
    ).rejects.toThrow(/configured size limit/)
    expect(oversizedLoadCalls).toBe(0)

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
    const pairingIdentifier = pairingId(new Uint8Array(16).fill(8))
    const request = createPairingDeviceRequest(pairingIdentifier, first.device.vaultId, pending, {
      deviceName: "Stanislas’s iPhone",
      platform: "iOS",
    })
    expect(verifyPairingDeviceRequest(request)).toBe(true)
    expect(verifyPairingDeviceRequest({ ...request, deviceName: "Substituted phone" })).toBe(false)
    expect(() =>
      createPairingDeviceRequest(pairingIdentifier, first.device.vaultId, pending, {
        deviceName: "x".repeat(81),
        platform: "iOS",
      }),
    ).toThrow(/between 1 and 80/)
    const prepared = await preparePairingEpochPackage({
      approver: first.device,
      request,
      recoveryPublicKey: first.recoveryPublicKey,
      authorizationChain: [first.device.certificate],
      expiresAt: Date.now() + 60_000,
    })
    const serializedPackage = serializePairingPackage(prepared.package)
    expect(bytesEqual(prepared.preview.transferHash, await sha256(serializedPackage))).toBe(true)
    expect(prepared.preview.context.newDeviceName).toBe("Stanislas’s iPhone")
    expect(prepared.preview.context.newDevicePlatform).toBe("iOS")

    const serializedPreview = serializePairingVerificationPreview(prepared.preview)
    const previewEnvelope = decodeCanonical(serializedPreview) as Record<string, unknown>
    expect(Object.keys(previewEnvelope).sort()).toEqual([
      "approverDeviceId",
      "context",
      "signature",
      "transferHash",
    ])
    expect(previewEnvelope).not.toHaveProperty("transfer")
    const transportedPreview = deserializePairingVerificationPreview(serializedPreview)
    const inspected = await inspectPairingVerificationPreview(
      pending,
      transportedPreview,
      Date.now(),
    )
    expect(inspected.verificationPhrase).toBe(prepared.verificationPhrase)
    expect(bytesEqual(inspected.transferHash, prepared.preview.transferHash)).toBe(true)

    const tamperedHash = new Uint8Array(transportedPreview.transferHash)
    tamperedHash[0] = (tamperedHash[0] ?? 0) ^ 1
    await expect(
      inspectPairingVerificationPreview(
        pending,
        {
          ...transportedPreview,
          transferHash: tamperedHash as typeof transportedPreview.transferHash,
        },
        Date.now(),
      ),
    ).rejects.toThrow(/preview signature/)

    const invalidCheckpointSignature = new Uint8Array(
      transportedPreview.context.checkpoint.signature,
    )
    invalidCheckpointSignature[0] = (invalidCheckpointSignature[0] ?? 0) ^ 1
    const invalidCheckpointContext = {
      ...transportedPreview.context,
      checkpoint: {
        ...transportedPreview.context.checkpoint,
        signature: ed25519Signature(invalidCheckpointSignature),
      },
    }
    await expect(
      inspectPairingVerificationPreview(
        pending,
        {
          ...transportedPreview,
          context: invalidCheckpointContext,
          signature: signPairingVerificationPreview(
            invalidCheckpointContext,
            transportedPreview.approverDeviceId,
            transportedPreview.transferHash,
            first.device.signingPrivateKey,
          ),
        },
        Date.now(),
      ),
    ).rejects.toThrow(/checkpoint signature/)

    const invalidEpochSignature = new Uint8Array(transportedPreview.context.epoch.signature)
    invalidEpochSignature[0] = (invalidEpochSignature[0] ?? 0) ^ 1
    const invalidEpochContext = {
      ...transportedPreview.context,
      epoch: {
        ...transportedPreview.context.epoch,
        signature: ed25519Signature(invalidEpochSignature),
      },
    }
    await expect(
      inspectPairingVerificationPreview(
        pending,
        {
          ...transportedPreview,
          context: invalidEpochContext,
          signature: signPairingVerificationPreview(
            invalidEpochContext,
            transportedPreview.approverDeviceId,
            transportedPreview.transferHash,
            first.device.signingPrivateKey,
          ),
        },
        Date.now(),
      ),
    ).rejects.toThrow(/epoch signature/)

    const recoveryKeys = await deriveRecoveryKeys(await parseRecoveryCode(first.recoveryCode))
    const limitedCertificate = signDeviceCertificate(
      {
        ...first.device.certificate.body,
        permissions: first.device.certificate.body.permissions.filter(
          (permission) => permission !== Permission.RotateEpoch,
        ),
      },
      recoveryKeys.signingPrivateKey,
    )
    const unauthorizedEpoch = signEpochDeclaration(
      {
        ...transportedPreview.context.epoch.body,
        createdBy: first.device.deviceId,
      },
      first.device.signingPrivateKey,
    )
    const unauthorizedEpochContext = {
      ...transportedPreview.context,
      authorizationChain: [limitedCertificate],
      epoch: unauthorizedEpoch,
    }
    await expect(
      inspectPairingVerificationPreview(
        pending,
        {
          ...transportedPreview,
          context: unauthorizedEpochContext,
          signature: signPairingVerificationPreview(
            unauthorizedEpochContext,
            transportedPreview.approverDeviceId,
            transportedPreview.transferHash,
            first.device.signingPrivateKey,
          ),
        },
        Date.now(),
      ),
    ).rejects.toThrow(/cannot rotate vault epochs/)

    const rootCertificate = transportedPreview.context.authorizationChain[0]
    if (rootCertificate === undefined) throw new Error("expected an authorization root")
    const invalidRootSignature = new Uint8Array(rootCertificate.signature)
    invalidRootSignature[0] = (invalidRootSignature[0] ?? 0) ^ 1
    const invalidChainContext = {
      ...transportedPreview.context,
      authorizationChain: [
        {
          ...rootCertificate,
          signature: ed25519Signature(invalidRootSignature),
        },
      ],
    }
    await expect(
      inspectPairingVerificationPreview(
        pending,
        {
          ...transportedPreview,
          context: invalidChainContext,
          signature: signPairingVerificationPreview(
            invalidChainContext,
            transportedPreview.approverDeviceId,
            transportedPreview.transferHash,
            first.device.signingPrivateKey,
          ),
        },
        Date.now(),
      ),
    ).rejects.toThrow(/certificate/)

    const transported = deserializePairingPackage(serializedPackage)
    const tamperedCiphertext = new Uint8Array(transported.transfer.ciphertext)
    tamperedCiphertext[0] = (tamperedCiphertext[0] ?? 0) ^ 1
    await expect(
      consumePairingEpochPackage({
        pending,
        package: {
          ...transported,
          transfer: { ...transported.transfer, ciphertext: tamperedCiphertext },
        },
        expectedTransferHash: inspected.transferHash,
        confirmedVerificationPhrase: inspected.verificationPhrase,
        now: Date.now(),
      }),
    ).rejects.toThrow(/verified preview/)

    const paired = await consumePairingEpochPackage({
      pending,
      package: transported,
      expectedTransferHash: inspected.transferHash,
      confirmedVerificationPhrase: inspected.verificationPhrase,
      now: Date.now(),
    })
    expect(bytesEqual(paired.vaultEpochKey, first.device.vaultEpochKey)).toBe(true)
    expect(bytesEqual(paired.deviceId, pending.deviceId)).toBe(true)
    expect(() => deserializeDeviceKeyBundle(serializeDeviceKeyBundle(paired))).not.toThrow()
  })
})
