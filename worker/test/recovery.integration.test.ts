import { SELF } from "cloudflare:test"
import {
  createFirstDeviceClaimBundle,
  recoverDeviceFromPackage,
  serializeEncryptedRecoveryPackage,
  sign,
  signRecoveryClaim,
} from "@meridian/crypto"
import { encodeDeviceCertificate } from "@meridian/protocol"
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

  const packageResponse = await SELF.fetch("https://example.test/v1/recovery/package")
  expect(packageResponse.status).toBe(200)
  const packagePayload = (await packageResponse.json()) as {
    encryptedRecoveryPackage: string
  }
  expect(packagePayload.encryptedRecoveryPackage).toBe(
    base64UrlEncode(serializeEncryptedRecoveryPackage(first.encryptedRecoveryPackage)),
  )

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
  const proof = await signRecoveryClaim(first.recoveryCode, {
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
  expect(replay.status).toBe(401)
})
