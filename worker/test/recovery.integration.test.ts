import { env, runInDurableObject, SELF } from "cloudflare:test"
import {
  computeRecoveryStateId,
  createFirstDeviceClaimBundle,
  recoverDeviceFromPackage,
  serializeEncryptedRecoveryPackage,
  sign,
  signRecoveryClaim,
} from "@meridian/crypto"
import { encodeDeviceCertificate, hashBytes, recoveryId } from "@meridian/protocol"
import { expect, it } from "vitest"
import { base64UrlDecode, base64UrlEncode } from "../src/encoding"
import type { RecoveryClaim, SetupClaim } from "../src/schemas"
import { setupClaimSigningMessage } from "../src/vault-do"

const SETUP_TOKEN = "integration-test-setup-token-32-bytes-long"

it("recovers ownership into a fresh device using only the recovery code", async () => {
  const first = await createFirstDeviceClaimBundle()
  const setupResponse = await SELF.fetch("https://example.test/v1/setup/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: SETUP_TOKEN }),
  })
  expect(setupResponse.status).toBe(200)
  const setup = (await setupResponse.json()) as {
    setupSession: string
    claimChallenge: string
  }
  const unsignedClaim: SetupClaim = {
    setupSession: setup.setupSession,
    vaultId: base64UrlEncode(first.device.vaultId),
    recoverySigningPublicKey: base64UrlEncode(first.recoveryPublicKey),
    encryptedRecoveryPackage: base64UrlEncode(
      serializeEncryptedRecoveryPackage(first.encryptedRecoveryPackage),
    ),
    initialDevice: {
      deviceId: base64UrlEncode(first.device.deviceId),
      signingPublicKey: base64UrlEncode(first.device.signingPublicKey),
      hpkePublicKey: base64UrlEncode(first.device.hpkePublicKey),
      certificate: base64UrlEncode(encodeDeviceCertificate(first.device.certificate)),
    },
    proof: "",
  }
  const claim: SetupClaim = {
    ...unsignedClaim,
    proof: base64UrlEncode(
      sign(
        setupClaimSigningMessage(unsignedClaim, setup.claimChallenge),
        first.device.signingPrivateKey,
      ),
    ),
  }
  const claimed = await SELF.fetch("https://example.test/v1/setup/claim", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(claim),
  })
  expect(claimed.status).toBe(201)

  const primaryStub = env.VAULT.get(env.VAULT.idFromName("primary"))
  await runInDurableObject(primaryStub, async (_instance, state) => {
    state.storage.sql.exec("UPDATE vault_state SET recovery_state_id = NULL")
  })
  const packageResponse = await SELF.fetch("https://example.test/v1/recovery/package")
  expect(packageResponse.status).toBe(200)
  const packagePayload = (await packageResponse.json()) as {
    encryptedRecoveryPackage: string
    recoveryStateId: string
  }
  const initialPackage = serializeEncryptedRecoveryPackage(first.encryptedRecoveryPackage)
  expect(packagePayload.encryptedRecoveryPackage).toBe(base64UrlEncode(initialPackage))
  expect(packagePayload.recoveryStateId).toBe(
    base64UrlEncode(await computeRecoveryStateId(first.device.vaultId, initialPackage)),
  )
  await runInDurableObject(primaryStub, async (_instance, state) => {
    expect(
      state.storage.sql
        .exec<{ recovery_state_id: string }>(
          "SELECT recovery_state_id FROM vault_state WHERE singleton = 1",
        )
        .one().recovery_state_id,
    ).toBe(packagePayload.recoveryStateId)
  })

  const replacement = await recoverDeviceFromPackage(
    first.recoveryCode,
    first.encryptedRecoveryPackage,
  )
  const challengeResponse = await SELF.fetch("https://example.test/v1/recovery/challenge", {
    method: "POST",
  })
  expect(challengeResponse.status).toBe(200)
  const challenge = (await challengeResponse.json()) as {
    challengeId: string
    challenge: string
  }
  const repeatedChallengeResponse = await SELF.fetch("https://example.test/v1/recovery/challenge", {
    method: "POST",
  })
  expect(repeatedChallengeResponse.status).toBe(200)
  await expect(repeatedChallengeResponse.json()).resolves.toMatchObject(challenge)

  const replacementPackage = serializeEncryptedRecoveryPackage(replacement.encryptedRecoveryPackage)
  const certificate = encodeDeviceCertificate(replacement.device.certificate)
  const recoveryIdentifier = recoveryId(new Uint8Array(16).fill(9))
  const proof = await signRecoveryClaim(first.recoveryCode, {
    claimVersion: 2,
    recoveryId: recoveryIdentifier,
    previousRecoveryStateId: hashBytes(base64UrlDecode(packagePayload.recoveryStateId, 32)),
    challengeId: challenge.challengeId,
    challenge: base64UrlDecode(challenge.challenge, 32),
    vaultId: replacement.device.vaultId,
    deviceId: replacement.device.deviceId,
    signingPublicKey: replacement.device.signingPublicKey,
    hpkePublicKey: replacement.device.hpkePublicKey,
    certificate,
    encryptedRecoveryPackage: replacementPackage,
  })
  const recoveryClaim: RecoveryClaim = {
    claimVersion: 2,
    recoveryId: base64UrlEncode(recoveryIdentifier),
    previousRecoveryStateId: packagePayload.recoveryStateId,
    challengeId: challenge.challengeId,
    newDevice: {
      deviceId: base64UrlEncode(replacement.device.deviceId),
      signingPublicKey: base64UrlEncode(replacement.device.signingPublicKey),
      hpkePublicKey: base64UrlEncode(replacement.device.hpkePublicKey),
      certificate: base64UrlEncode(certificate),
    },
    encryptedRecoveryPackage: base64UrlEncode(replacementPackage),
    proof: base64UrlEncode(proof),
  }
  const {
    claimVersion: _claimVersion,
    recoveryId: _recoveryId,
    previousRecoveryStateId: _predecessor,
    ...legacyClaim
  } = recoveryClaim
  const legacyResponse = await SELF.fetch("https://example.test/v1/recovery/claim", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(legacyClaim),
  })
  expect(legacyResponse.status).toBe(426)

  const recovered = await SELF.fetch("https://example.test/v1/recovery/claim", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(recoveryClaim),
  })
  expect(recovered.status).toBe(201)

  const replay = await SELF.fetch("https://example.test/v1/recovery/claim", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(recoveryClaim),
  })
  expect(replay.status).toBe(200)
  await expect(replay.json()).resolves.toMatchObject({ duplicate: true })

  const staleReplacement = await recoverDeviceFromPackage(
    first.recoveryCode,
    first.encryptedRecoveryPackage,
  )
  const staleChallengeResponse = await SELF.fetch("https://example.test/v1/recovery/challenge", {
    method: "POST",
  })
  const staleChallenge = (await staleChallengeResponse.json()) as {
    challengeId: string
    challenge: string
  }
  const stalePackage = serializeEncryptedRecoveryPackage(staleReplacement.encryptedRecoveryPackage)
  const staleCertificate = encodeDeviceCertificate(staleReplacement.device.certificate)
  const staleIdentifier = recoveryId(new Uint8Array(16).fill(10))
  const staleProof = await signRecoveryClaim(first.recoveryCode, {
    claimVersion: 2,
    recoveryId: staleIdentifier,
    previousRecoveryStateId: hashBytes(base64UrlDecode(packagePayload.recoveryStateId, 32)),
    challengeId: staleChallenge.challengeId,
    challenge: base64UrlDecode(staleChallenge.challenge, 32),
    vaultId: staleReplacement.device.vaultId,
    deviceId: staleReplacement.device.deviceId,
    signingPublicKey: staleReplacement.device.signingPublicKey,
    hpkePublicKey: staleReplacement.device.hpkePublicKey,
    certificate: staleCertificate,
    encryptedRecoveryPackage: stalePackage,
  })
  const staleResponse = await SELF.fetch("https://example.test/v1/recovery/claim", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      claimVersion: 2,
      recoveryId: base64UrlEncode(staleIdentifier),
      previousRecoveryStateId: packagePayload.recoveryStateId,
      challengeId: staleChallenge.challengeId,
      newDevice: {
        deviceId: base64UrlEncode(staleReplacement.device.deviceId),
        signingPublicKey: base64UrlEncode(staleReplacement.device.signingPublicKey),
        hpkePublicKey: base64UrlEncode(staleReplacement.device.hpkePublicKey),
        certificate: base64UrlEncode(staleCertificate),
      },
      encryptedRecoveryPackage: base64UrlEncode(stalePackage),
      proof: base64UrlEncode(staleProof),
    }),
  })
  expect(staleResponse.status).toBe(409)
  await expect(staleResponse.json()).resolves.toMatchObject({
    error: { code: "stale_recovery_state" },
  })
})
