import {
  deviceAuthSigningBytes,
  httpOperationSigningBytes,
  setupClaimSigningBytes,
  signedHttpMessage,
} from "../src/index.js"
import { describe, expect, it } from "vitest"

const text = new TextDecoder()

describe("HTTP signing frames", () => {
  it("uses domain-separated unambiguous length prefixes", () => {
    const first = signedHttpMessage("test/v1", [["a", "bc"]])
    const second = signedHttpMessage("test/v1", [["ab", "c"]])
    expect(first).not.toEqual(second)
    expect(text.decode(first)).toBe("MERIDIAN\u0000test/v1\u0000a\u00002\u0000bc")
  })

  it("binds setup recovery material and challenge", () => {
    const base = {
      vaultId: "vault",
      deviceId: "device",
      signingPublicKey: "signing",
      hpkePublicKey: "hpke",
      certificate: new Uint8Array([1]),
      recoverySigningPublicKey: "recovery",
      encryptedRecoveryPackage: new Uint8Array([2]),
      setupSession: "session",
      challenge: "challenge",
    }
    expect(setupClaimSigningBytes(base)).not.toEqual(
      setupClaimSigningBytes({ ...base, encryptedRecoveryPackage: new Uint8Array([3]) }),
    )
    expect(setupClaimSigningBytes(base)).not.toEqual(
      setupClaimSigningBytes({ ...base, challenge: "other" }),
    )
  })

  it("binds auth and operation identities independently", () => {
    expect(
      deviceAuthSigningBytes({
        vaultId: "vault",
        deviceId: "device",
        challengeId: "id",
        challenge: "challenge",
      }),
    ).not.toEqual(
      deviceAuthSigningBytes({
        vaultId: "vault",
        deviceId: "other",
        challengeId: "id",
        challenge: "challenge",
      }),
    )
    const operation = {
      operationId: "operation",
      authorDeviceId: "device",
      epochId: "epoch",
      type: "revision",
      envelope: new Uint8Array([4]),
    }
    expect(httpOperationSigningBytes(operation)).not.toEqual(
      httpOperationSigningBytes({ ...operation, subjectDeviceId: "revoked-device" }),
    )
  })
})
