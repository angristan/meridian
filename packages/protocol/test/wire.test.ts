import { describe, expect, it } from "vitest"
import {
  acceptAuthorizedEpoch,
  assertConsistentHighWaterMark,
  CIPHER_SUITE,
  certificateId,
  type DeviceCertificate,
  decodeDeviceCertificate,
  deviceId,
  type EpochDeclarationBody,
  ed25519PublicKey,
  ed25519Signature,
  encodeCanonical,
  encodeDeviceCertificate,
  epochId,
  hashBytes,
  Permission,
  vaultId,
  x25519PublicKey,
} from "../src/index.js"

const fill = (length: number, value: number) => new Uint8Array(length).fill(value)

function certificate(): DeviceCertificate {
  return {
    body: {
      certificateId: certificateId(fill(16, 1)),
      vaultId: vaultId(fill(16, 2)),
      deviceId: deviceId(fill(16, 3)),
      signingPublicKey: ed25519PublicKey(fill(32, 4)),
      hpkePublicKey: x25519PublicKey(fill(32, 5)),
      permissions: [Permission.Read, Permission.Write],
      issuer: { kind: "recovery" },
      epochId: epochId(fill(16, 6)),
      suite: CIPHER_SUITE,
      validFromCursor: 0,
      expiresAt: null,
    },
    signature: ed25519Signature(fill(64, 7)),
  }
}

describe("protocol wire models", () => {
  it("round-trips a device certificate", () => {
    expect(decodeDeviceCertificate(encodeDeviceCertificate(certificate()))).toEqual(certificate())
  })

  it("rejects unknown certificate fields", () => {
    const valid = certificate()
    const body = {
      certificateId: valid.body.certificateId,
      vaultId: valid.body.vaultId,
      deviceId: valid.body.deviceId,
      signingPublicKey: valid.body.signingPublicKey,
      hpkePublicKey: valid.body.hpkePublicKey,
      permissions: valid.body.permissions,
      issuer: { kind: "recovery" },
      epochId: valid.body.epochId,
      suite: { ...CIPHER_SUITE },
      validFromCursor: 0,
      expiresAt: null,
      criticalSurprise: true,
    }
    expect(() =>
      decodeDeviceCertificate(encodeCanonical({ body, signature: valid.signature })),
    ).toThrow(/unknown fields/)
  })

  it("rejects rollback and downgrade", () => {
    const trusted = {
      cursor: 8,
      logHash: hashBytes(fill(32, 9)),
      protocolGeneration: 1,
    }
    expect(() =>
      assertConsistentHighWaterMark(trusted, {
        cursor: 7,
        logHash: trusted.logHash,
        protocolGeneration: 1,
      }),
    ).toThrow(/backwards/)

    const epoch: EpochDeclarationBody = {
      vaultId: vaultId(fill(16, 1)),
      epochId: epochId(fill(16, 2)),
      sequence: 3,
      previousEpochId: epochId(fill(16, 3)),
      suite: CIPHER_SUITE,
      createdBy: "recovery",
      reason: "migration",
    }
    expect(() =>
      acceptAuthorizedEpoch({ highestProtocolGeneration: 2, highestEpochSequence: 2 }, epoch),
    ).toThrow(/downgrade/)
  })
})
