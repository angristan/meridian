import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import {
  AuthSessionSchema,
  ChangesResponseSchema,
  DeviceListResponseSchema,
  OperationSchema,
} from "../src/index.js"

const decode = <S extends Schema.ConstraintDecoder<unknown, never>>(schema: S, input: unknown) =>
  Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(input)

const storedOperation = {
  cursor: 4,
  operationId: "operation-id",
  authorDeviceId: "device-id",
  epochId: "epoch-id",
  type: "merge",
  envelope: "envelope",
  signature: "signature",
  previousHash: "previous-hash",
  chainHash: "chain-hash",
  committedAt: 123,
} as const

describe("HTTP schemas", () => {
  it("accepts only the current session proof fields", () => {
    const request = {
      deviceId: "device-id",
      challengeId: "challenge-id",
      signature: "signature",
    }

    expect(decode(AuthSessionSchema, request)).toEqual(request)
    expect(() => decode(AuthSessionSchema, { ...request, legacyCapability: true })).toThrow()
  })

  it("separates writable operations from legacy stored operation types", () => {
    const writable = {
      operationId: "operation-id",
      authorDeviceId: "device-id",
      epochId: "epoch-id",
      type: "revision",
      envelope: "envelope",
      signature: "signature",
    }

    expect(decode(OperationSchema, writable)).toEqual(writable)
    expect(decode(OperationSchema, { ...writable, type: "tombstone" })).toMatchObject({
      type: "tombstone",
    })
    expect(decode(OperationSchema, { ...writable, type: "restore" })).toMatchObject({
      type: "restore",
    })
    expect(() => decode(OperationSchema, { ...writable, type: "merge" })).toThrow()
    expect(() => decode(OperationSchema, { ...writable, type: "log-format-transition" })).toThrow()
  })

  it("preserves every stored operation field needed for verification", () => {
    const response = {
      operations: [storedOperation],
      latestCursor: 4,
      latestHash: "chain-hash",
      hasMore: false,
    }

    expect(decode(ChangesResponseSchema, response)).toEqual(response)
    expect(() => decode(ChangesResponseSchema, { operations: [storedOperation] })).toThrow()
  })

  it("decodes the current device registry", () => {
    const device = {
      deviceId: "device-id",
      signingPublicKey: "signing-key",
      hpkePublicKey: "hpke-key",
      certificate: "certificate",
      role: "owner",
      authorizedAt: 1,
      authorizedBy: null,
      revokedAt: null,
      revokedOperationId: null,
      deviceName: null,
      platform: null,
    }

    expect(decode(DeviceListResponseSchema, { devices: [device] })).toEqual({ devices: [device] })
  })
})
