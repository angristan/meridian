import { computeRecoveryStateId, deserializeEncryptedRecoveryPackage } from "@meridian/crypto"
import { describe, expect, it } from "vitest"
import { createPackageCryptoPort } from "../src/crypto/package-adapter"
import { fromBase64Url, randomId, toBase64Url } from "../src/platform/bytes"

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected object")
  }
  return value as Record<string, unknown>
}

function stringField(value: unknown, key: string): string {
  const field = record(value)[key]
  if (typeof field !== "string") throw new Error(`Missing ${key}`)
  return field
}

describe("shared crypto adapter", () => {
  it("creates SecretStorage material and round-trips an encrypted revision", async () => {
    const crypto = createPackageCryptoPort()
    const claim = await crypto.createFirstDevice("setup-session", "claim-challenge")
    const device = await crypto.loadDevice(claim.keyBundle)
    const plaintext = new TextEncoder().encode("private note").buffer
    const encrypted = await crypto.encryptRevision(device, {
      operationId: randomId(),
      revisionId: randomId(),
      fileId: randomId(),
      action: "upsert",
      path: "note.md",
      previousPath: null,
      parents: [],
      bytes: plaintext,
      chunkSize: 4 * 1024 * 1024,
    })
    const blobs = new Map(encrypted.blobs.map((blob) => [blob.blobId, blob.bytes]))
    await expect(
      crypto.inspectRevision(
        device,
        { cursor: 1, logHash: randomId(32), envelope: encrypted.envelope },
        Number.MAX_SAFE_INTEGER,
      ),
    ).resolves.toMatchObject({ path: "note.md", byteLength: 12, isText: true })
    const transferProgress: Array<{
      completedChunks: number
      totalChunks: number
      transferredBytes: number
      totalBytes: number
    }> = []
    const decrypted = await crypto.decryptRevision(
      device,
      { cursor: 1, logHash: randomId(32), envelope: encrypted.envelope },
      Number.MAX_SAFE_INTEGER,
      async (blobId) => {
        const bytes = blobs.get(blobId)
        if (!bytes) throw new Error("Missing encrypted test blob")
        return bytes
      },
      (progress) => transferProgress.push(progress),
    )

    expect(transferProgress).toEqual([
      { completedChunks: 1, totalChunks: 1, transferredBytes: 12, totalBytes: 12 },
    ])
    expect(claim.recoveryCode).toMatch(/^mdn1[.-]/)
    expect(claim.publicClaim).toMatchObject({ setupSession: "setup-session" })
    expect(device.deviceId).toBe(claim.deviceId)
    expect(device.trustedCheckpointAuthorized).toBe(true)
    const legacySecret = JSON.parse(claim.keyBundle) as Record<string, unknown>
    legacySecret.version = 1
    delete legacySecret.checkpointAuthorizationChain
    await expect(crypto.loadDevice(JSON.stringify(legacySecret))).resolves.toMatchObject({
      deviceId: claim.deviceId,
      trustedCheckpointAuthorized: false,
    })
    if (!decrypted.bytes) throw new Error("Expected decrypted revision content")
    expect(new TextDecoder().decode(decrypted.bytes)).toBe("private note")
    expect(decrypted.path).toBe("note.md")

    await expect(
      crypto.decryptRevision(
        device,
        {
          cursor: 1,
          logHash: randomId(32),
          envelope: { ...record(encrypted.envelope), operationId: randomId() },
        },
        Number.MAX_SAFE_INTEGER,
        async () => {
          throw new Error("Tampered operations must be rejected before loading blobs")
        },
      ),
    ).rejects.toThrow(/file operation signature is invalid/)

    let oversizedLoadCalls = 0
    await expect(
      crypto.decryptRevision(
        device,
        { cursor: 1, logHash: randomId(32), envelope: encrypted.envelope },
        11,
        async () => {
          oversizedLoadCalls += 1
          return new ArrayBuffer(0)
        },
      ),
    ).rejects.toThrow(/mobile-safe file size limit/)
    expect(oversizedLoadCalls).toBe(0)

    const serializedRecoveryPackage = fromBase64Url(
      stringField(claim.publicClaim, "encryptedRecoveryPackage"),
    )
    const encryptedRecoveryPackage = deserializeEncryptedRecoveryPackage(serializedRecoveryPackage)
    const recoveryStateId = toBase64Url(
      await computeRecoveryStateId(encryptedRecoveryPackage.vaultId, serializedRecoveryPackage),
    )
    await expect(
      crypto.recoverDevice(
        claim.recoveryCode,
        stringField(claim.publicClaim, "encryptedRecoveryPackage"),
        randomId(32),
        { challengeId: "recovery-challenge", challenge: randomId(32) },
      ),
    ).rejects.toThrow(/state ID does not match/)
    const recovered = await crypto.recoverDevice(
      claim.recoveryCode,
      stringField(claim.publicClaim, "encryptedRecoveryPackage"),
      recoveryStateId,
      { challengeId: "recovery-challenge", challenge: randomId(32) },
    )
    const recoveredDevice = await crypto.loadDevice(recovered.keyBundle)
    expect(recovered.vaultId).toBe(claim.vaultId)
    expect(recovered.deviceId).not.toBe(claim.deviceId)
    expect(recoveredDevice.deviceId).toBe(recovered.deviceId)
    expect(recoveredDevice.trustedCheckpointAuthorized).toBe(true)
    expect(record(recovered.publicClaim)).toMatchObject({
      claimVersion: 2,
      previousRecoveryStateId: recoveryStateId,
      challengeId: "recovery-challenge",
    })
  })

  it("applies epoch transitions after an offline checkpoint and retries safely", async () => {
    const crypto = createPackageCryptoPort()
    const claim = await crypto.createFirstDevice("setup-session", "claim-challenge")
    const device = await crypto.loadDevice(claim.keyBundle)
    const initialDevice = record(record(claim.publicClaim).initialDevice)
    const oldRevision = await crypto.encryptRevision(device, {
      operationId: randomId(),
      revisionId: randomId(),
      fileId: randomId(),
      action: "upsert",
      path: "history.md",
      previousPath: null,
      parents: [],
      bytes: new TextEncoder().encode("old epoch").buffer,
      chunkSize: 4 * 1024 * 1024,
    })
    const predecessor = { cursor: 5, logHash: randomId(32) }
    const caughtUpDevice = await crypto.refreshTrustedCheckpoint(device, predecessor)
    const material = await crypto.createEpochTransition(
      caughtUpDevice,
      [
        {
          deviceId: device.deviceId,
          signingPublicKey: stringField(initialDevice, "signingPublicKey"),
          hpkePublicKey: stringField(initialDevice, "hpkePublicKey"),
          certificate: stringField(initialDevice, "certificate"),
          role: "owner",
          authorizedAt: 0,
          revokedAt: null,
          deviceName: "Owner",
          platform: "Test",
          supportsCanonicalLog: true,
          supportsEpochTransitions: true,
        },
      ],
      randomId(32),
      "migration",
    )
    const operation = {
      cursor: 6,
      logHash: randomId(32),
      envelope: material.envelope,
    }
    await expect(
      crypto.applyEpochTransition(device, operation, {
        ...predecessor,
        logHash: randomId(32),
      }),
    ).rejects.toThrow(/verified predecessor/)

    const rotated = await crypto.applyEpochTransition(device, operation, predecessor)

    expect(device.trustedCheckpoint.cursor).toBe(0)
    expect(rotated.epochSequence).toBe(1)
    expect(rotated.epochId).toBe(material.nextEpochId)
    expect(rotated.trustedCheckpoint).toMatchObject({
      cursor: operation.cursor,
      logHash: operation.logHash,
    })
    await expect(
      crypto.applyEpochTransition(rotated, operation, predecessor),
    ).resolves.toMatchObject({
      serialized: rotated.serialized,
      epochId: rotated.epochId,
      epochSequence: rotated.epochSequence,
    })
    const blobs = new Map(oldRevision.blobs.map((blob) => [blob.blobId, blob.bytes]))
    const decrypted = await crypto.decryptRevision(
      rotated,
      { cursor: 2, logHash: randomId(32), envelope: oldRevision.envelope },
      Number.MAX_SAFE_INTEGER,
      async (blobId) => {
        const blob = blobs.get(blobId)
        if (!blob) throw new Error("Missing retained old-epoch blob")
        return blob
      },
    )
    if (!decrypted.bytes) throw new Error("Expected old-epoch revision content")
    expect(new TextDecoder().decode(decrypted.bytes)).toBe("old epoch")
  })

  it("creates signed device revocations bound to their target certificate", async () => {
    const crypto = createPackageCryptoPort()
    const claim = await crypto.createFirstDevice("setup-session", "claim-challenge")
    const owner = await crypto.loadDevice(claim.keyBundle)
    const ownerCertificate = stringField(record(claim.publicClaim).initialDevice, "certificate")
    const joining = await crypto.createPairingJoin(
      {
        pairingId: randomId(),
        capability: randomId(32),
        vaultId: owner.vaultId,
        expiresAt: Date.now() + 300_000,
      },
      { deviceName: "Old iPhone", platform: "iOS" },
    )
    const approval = await crypto.approvePairing(owner, joining.candidatePackage, [
      ownerCertificate,
    ])
    const targetDeviceId = stringField(JSON.parse(joining.candidatePackage), "deviceId")
    const targetCertificate = stringField(approval.payload, "certificate")

    const replacementJoin = await crypto.createPairingJoin(
      {
        pairingId: randomId(),
        capability: randomId(32),
        vaultId: owner.vaultId,
        expiresAt: Date.now() + 300_000,
      },
      { deviceName: "Replacement iPhone", platform: "iOS" },
    )
    const replacementApproval = await crypto.approvePairing(
      owner,
      replacementJoin.candidatePackage,
      [ownerCertificate, targetCertificate, "malformed-unrelated-history"],
    )
    await expect(
      crypto.inspectPairingVerification(
        replacementJoin.pendingSecret,
        stringField(replacementApproval.payload, "verificationPreview"),
      ),
    ).resolves.toMatchObject({ verificationPhrase: replacementApproval.verificationPhrase })

    const target = {
      deviceId: targetDeviceId,
      signingPublicKey: stringField(JSON.parse(joining.candidatePackage), "signingPublicKey"),
      hpkePublicKey: stringField(JSON.parse(joining.candidatePackage), "hpkePublicKey"),
      certificate: targetCertificate,
      role: "member" as const,
      authorizedAt: 1,
      revokedAt: null,
      deviceName: "Old iPhone",
      platform: "iOS",
    }
    const revocation = await crypto.createDeviceRevocation(owner, target)
    const operation = {
      cursor: 1,
      logHash: randomId(32),
      envelope: revocation.envelope,
      certificateChain: [ownerCertificate, targetCertificate],
    }

    await expect(crypto.verifyDeviceRevocation(owner, operation)).resolves.toEqual({
      deviceId: targetDeviceId,
      operationId: revocation.operationId,
      cursor: 1,
    })
    await expect(
      crypto.verifyDeviceRevocation(owner, {
        ...operation,
        envelope: { ...record(revocation.envelope), subjectDeviceId: randomId() },
      }),
    ).rejects.toThrow(/signature is invalid/)

    const verification = await crypto.inspectPairingVerification(
      joining.pendingSecret,
      stringField(approval.payload, "verificationPreview"),
    )
    const paired = await crypto.consumePairingResult(
      joining.pendingSecret,
      stringField(approval.releasePayload, "hpkeTransfer"),
      verification.verificationPhrase,
      verification.transferHash,
    )
    const member = await crypto.loadDevice(paired.keyBundle)
    const selfRevocation = await crypto.createDeviceRevocation(member, target)
    await expect(
      crypto.verifyDeviceRevocation(owner, {
        cursor: 2,
        logHash: randomId(32),
        envelope: selfRevocation.envelope,
        authorCertificate: targetCertificate,
        certificateChain: [ownerCertificate, targetCertificate],
      }),
    ).resolves.toEqual({
      deviceId: targetDeviceId,
      operationId: selfRevocation.operationId,
      cursor: 2,
    })
    await expect(
      crypto.createDeviceRevocation(member, {
        deviceId: owner.deviceId,
        signingPublicKey: stringField(record(claim.publicClaim).initialDevice, "signingPublicKey"),
        hpkePublicKey: stringField(record(claim.publicClaim).initialDevice, "hpkePublicKey"),
        certificate: ownerCertificate,
        role: "owner",
        authorizedAt: 0,
        revokedAt: null,
        deviceName: "Owner Mac",
        platform: "macOS",
      }),
    ).rejects.toThrow(/member device can remove only itself/)
    await expect(
      crypto.createDeviceRevocation(owner, { ...target, deviceId: owner.deviceId }),
    ).rejects.toThrow(/owner device cannot remove itself/)
  })

  it("pairs a second device and trusts its certificate for decryption", async () => {
    const crypto = createPackageCryptoPort()
    const ownerClaim = await crypto.createFirstDevice("setup-session", "claim-challenge")
    const owner = await crypto.loadDevice(ownerClaim.keyBundle)
    const joining = await crypto.createPairingJoin(
      {
        pairingId: randomId(),
        capability: randomId(32),
        vaultId: owner.vaultId,
        expiresAt: Date.now() + 300_000,
      },
      { deviceName: "Test iPhone", platform: "iOS" },
    )
    expect(stringField(joining.payload, "requestProof")).toBe(
      stringField(JSON.parse(joining.candidatePackage), "requestProof"),
    )
    const ownerCertificate = stringField(
      record(ownerClaim.publicClaim).initialDevice,
      "certificate",
    )
    const trustedHead = {
      cursor: 5,
      logHash: randomId(32),
      initialLogFormat: "canonical-cbor-v1" as const,
      logFormat: "canonical-cbor-v1" as const,
    }
    const refreshedOwner = await crypto.refreshTrustedCheckpoint(owner, trustedHead)
    expect(refreshedOwner).toMatchObject({
      trustedCheckpoint: trustedHead,
      trustedCheckpointAuthorized: true,
    })
    const approval = await crypto.approvePairing(refreshedOwner, joining.candidatePackage, [
      ownerCertificate,
    ])
    const approvalPayload = record(approval.payload)
    const releasePayload = record(approval.releasePayload)
    const verification = await crypto.inspectPairingVerification(
      joining.pendingSecret,
      stringField(approvalPayload, "verificationPreview"),
    )
    expect(verification.verificationPhrase).toBe(approval.verificationPhrase)
    expect(verification.transferHash).toBe(approval.transferHash)
    const confirmation = await crypto.createPairingConfirmation(
      joining.pendingSecret,
      verification.transferHash,
    )
    expect(confirmation.transferHash).toBe(verification.transferHash)
    await expect(
      crypto.verifyPairingConfirmation(joining.candidatePackage, confirmation),
    ).resolves.toBe(true)
    await expect(
      crypto.verifyPairingConfirmation(joining.candidatePackage, {
        ...confirmation,
        transferHash: randomId(32),
      }),
    ).resolves.toBe(false)
    const paired = await crypto.consumePairingResult(
      joining.pendingSecret,
      stringField(releasePayload, "hpkeTransfer"),
      verification.verificationPhrase,
      verification.transferHash,
    )
    const member = await crypto.loadDevice(paired.keyBundle)
    expect(member.trustedCheckpointAuthorized).toBe(true)
    expect(member.trustedCheckpoint).toEqual(trustedHead)

    const legacySecret = JSON.parse(paired.keyBundle) as Record<string, unknown>
    const completeChain = legacySecret.checkpointAuthorizationChain
    if (!Array.isArray(completeChain)) throw new Error("Expected stored authorization chain")
    expect(completeChain).toHaveLength(2)
    legacySecret.checkpointAuthorizationChain = completeChain.slice(1)
    const legacyMember = await crypto.loadDevice(JSON.stringify(legacySecret))
    expect(legacyMember.trustedCheckpointAuthorized).toBe(true)
    const memberHead = {
      ...trustedHead,
      cursor: 6,
      logHash: randomId(32),
    }
    const repairedMember = await crypto.refreshTrustedCheckpoint(legacyMember, memberHead)
    expect(repairedMember).toMatchObject({
      trustedCheckpoint: memberHead,
      trustedCheckpointAuthorized: true,
    })
    const repairedSecret = JSON.parse(repairedMember.serialized) as Record<string, unknown>
    expect(repairedSecret.checkpointAuthorizationChain).toHaveLength(2)

    const tamperedSecret = JSON.parse(paired.keyBundle) as Record<string, unknown>
    tamperedSecret.checkpointAuthorizationChain = []
    await expect(crypto.loadDevice(JSON.stringify(tamperedSecret))).resolves.toMatchObject({
      trustedCheckpointAuthorized: false,
    })
    const encrypted = await crypto.encryptRevision(repairedMember, {
      operationId: randomId(),
      revisionId: randomId(),
      fileId: randomId(),
      action: "upsert",
      path: "from-member.md",
      previousPath: null,
      parents: [],
      bytes: new TextEncoder().encode("member content").buffer,
      chunkSize: 4 * 1024 * 1024,
    })
    const blobs = new Map(encrypted.blobs.map((blob) => [blob.blobId, blob.bytes]))
    const decrypted = await crypto.decryptRevision(
      owner,
      {
        cursor: 6,
        logHash: randomId(32),
        envelope: encrypted.envelope,
        authorCertificate: stringField(approvalPayload, "certificate"),
        certificateChain: [ownerCertificate, stringField(approvalPayload, "certificate")],
      },
      Number.MAX_SAFE_INTEGER,
      async (blobId) => {
        const bytes = blobs.get(blobId)
        if (!bytes) throw new Error("Missing encrypted test blob")
        return bytes
      },
    )

    expect(repairedMember.vaultId).toBe(owner.vaultId)
    expect(decrypted.authorDeviceId).toBe(repairedMember.deviceId)
    expect(new TextDecoder().decode(decrypted.bytes ?? undefined)).toBe("member content")
  })
})
