import { describe, expect, it } from "vitest"
import {
  CIPHER_SUITE,
  checkpointLogFormats,
  decodeCheckpoint,
  decodeOperation,
  deviceId,
  ed25519Signature,
  encodeCheckpoint,
  encodeOperation,
  epochId,
  hashBytes,
  LogFormat,
  operationId,
  type SignedCheckpoint,
  type SignedOperation,
  vaultId,
} from "../src/index.js"

const fill = (length: number, value: number) => new Uint8Array(length).fill(value)

function transition(): SignedOperation {
  return {
    body: {
      type: "log-format-transition",
      operationId: operationId(fill(16, 1)),
      vaultId: vaultId(fill(16, 2)),
      epochId: epochId(fill(16, 3)),
      authorDeviceId: deviceId(fill(16, 4)),
      previousCursor: 42,
      previousLogHash: hashBytes(fill(32, 5)),
      nextLogFormat: LogFormat.CanonicalCborV1,
      suite: CIPHER_SUITE,
    },
    signature: ed25519Signature(fill(64, 6)),
  }
}

function checkpoint(versioned: boolean): SignedCheckpoint {
  return {
    body: {
      vaultId: vaultId(fill(16, 1)),
      epochId: epochId(fill(16, 2)),
      cursor: 8,
      logHash: hashBytes(fill(32, 3)),
      signerDeviceId: deviceId(fill(16, 4)),
      protocolGeneration: 1,
      ...(versioned
        ? {
            initialLogFormat: LogFormat.LegacyHttpV1,
            logFormat: LogFormat.CanonicalCborV1,
          }
        : {}),
    },
    signature: ed25519Signature(fill(64, 5)),
  }
}

describe("log format transitions", () => {
  it("round-trips a strict signed transition", () => {
    expect(decodeOperation(encodeOperation(transition()))).toEqual(transition())
  })

  it("keeps legacy checkpoints readable and defaults their format", () => {
    const decoded = decodeCheckpoint(encodeCheckpoint(checkpoint(false)))

    expect(decoded).toEqual(checkpoint(false))
    expect(checkpointLogFormats(decoded.body)).toEqual({
      initialLogFormat: LogFormat.LegacyHttpV1,
      logFormat: LogFormat.LegacyHttpV1,
    })
  })

  it("round-trips format-aware checkpoints and rejects downgrade", () => {
    expect(decodeCheckpoint(encodeCheckpoint(checkpoint(true)))).toEqual(checkpoint(true))
    expect(() =>
      encodeCheckpoint({
        ...checkpoint(true),
        body: {
          ...checkpoint(true).body,
          initialLogFormat: LogFormat.CanonicalCborV1,
          logFormat: LogFormat.LegacyHttpV1,
        },
      }),
    ).toThrow(/backwards/)
  })
})
