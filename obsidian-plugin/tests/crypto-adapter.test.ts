import { describe, expect, it } from "vitest"
import { createPackageCryptoPort } from "../src/crypto/package-adapter"
import { randomId } from "../src/platform/bytes"

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
    const transferProgress: Array<{
      completedChunks: number
      totalChunks: number
      transferredBytes: number
      totalBytes: number
    }> = []
    const decrypted = await crypto.decryptRevision(
      device,
      { cursor: 1, logHash: randomId(32), envelope: encrypted.envelope },
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
    if (!decrypted.bytes) throw new Error("Expected decrypted revision content")
    expect(new TextDecoder().decode(decrypted.bytes)).toBe("private note")
    expect(decrypted.path).toBe("note.md")

    const recovered = await crypto.recoverDevice(
      claim.recoveryCode,
      stringField(claim.publicClaim, "encryptedRecoveryPackage"),
      { challengeId: "recovery-challenge", challenge: randomId(32) },
    )
    const recoveredDevice = await crypto.loadDevice(recovered.keyBundle)
    expect(recovered.vaultId).toBe(claim.vaultId)
    expect(recovered.deviceId).not.toBe(claim.deviceId)
    expect(recoveredDevice.deviceId).toBe(recovered.deviceId)
    expect(record(recovered.publicClaim)).toMatchObject({
      challengeId: "recovery-challenge",
    })
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
    const approval = await crypto.approvePairing(owner, joining.candidatePackage, [
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
    const encrypted = await crypto.encryptRevision(member, {
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
        cursor: 1,
        logHash: randomId(32),
        envelope: encrypted.envelope,
        authorCertificate: stringField(approvalPayload, "certificate"),
        certificateChain: [ownerCertificate, stringField(approvalPayload, "certificate")],
      },
      async (blobId) => {
        const bytes = blobs.get(blobId)
        if (!bytes) throw new Error("Missing encrypted test blob")
        return bytes
      },
    )

    expect(member.vaultId).toBe(owner.vaultId)
    expect(decrypted.authorDeviceId).toBe(member.deviceId)
    expect(new TextDecoder().decode(decrypted.bytes ?? undefined)).toBe("member content")
  })
})
