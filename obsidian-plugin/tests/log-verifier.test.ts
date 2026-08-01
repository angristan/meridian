import {
  CIPHER_SUITE,
  deviceId,
  ed25519Signature,
  encodeOperation,
  epochId,
  hashBytes,
  httpOperationSigningBytes,
  LogFormat,
  logChainSigningBytes,
  logEntryHashInput,
  operationId,
  type SignedOperation,
  vaultId,
} from "@meridian/protocol"
import { describe, expect, it } from "vitest"
import type { RemoteOperation } from "../src/model"
import { toBase64Url } from "../src/platform/bytes"
import { assertRemoteLogLink } from "../src/sync/log-verifier"

const ZERO_HASH = toBase64Url(new Uint8Array(32))
const VAULT_BYTES = new Uint8Array(16).fill(1)
const VAULT_ID = toBase64Url(VAULT_BYTES)

async function legacyOperation(): Promise<RemoteOperation> {
  const envelope = toBase64Url(new Uint8Array([1, 2, 3]))
  const signature = toBase64Url(new Uint8Array(64))
  const operationMessage = httpOperationSigningBytes({
    operationId: "operation-id",
    authorDeviceId: "author-device",
    epochId: "epoch-id",
    type: "revision",
    envelope: new Uint8Array([1, 2, 3]),
  })
  const chainHash = await digest(
    logChainSigningBytes(new Uint8Array(32), operationMessage, new Uint8Array(64)),
  )
  return remoteOperation(envelope, signature, chainHash)
}

async function canonicalOperation(): Promise<RemoteOperation> {
  const signed: SignedOperation = {
    body: {
      type: "log-format-transition",
      operationId: operationId(new Uint8Array(16).fill(2)),
      vaultId: vaultId(VAULT_BYTES),
      epochId: epochId(new Uint8Array(16).fill(3)),
      authorDeviceId: deviceId(new Uint8Array(16).fill(4)),
      previousCursor: 0,
      previousLogHash: hashBytes(new Uint8Array(32)),
      nextLogFormat: LogFormat.CanonicalCborV1,
      suite: CIPHER_SUITE,
    },
    signature: ed25519Signature(new Uint8Array(64)),
  }
  const envelopeBytes = encodeOperation(signed)
  const chainHash = await digest(
    logEntryHashInput(vaultId(VAULT_BYTES), 1, hashBytes(new Uint8Array(32)), signed),
  )
  return remoteOperation(toBase64Url(envelopeBytes), toBase64Url(new Uint8Array(64)), chainHash)
}

function remoteOperation(envelope: string, signature: string, chainHash: string): RemoteOperation {
  return {
    cursor: 1,
    logHash: chainHash,
    envelope: {
      cursor: 1,
      operationId: "operation-id",
      authorDeviceId: "author-device",
      epochId: "epoch-id",
      type: "revision",
      envelope,
      signature,
      previousHash: ZERO_HASH,
      chainHash,
    },
  }
}

async function digest(value: Uint8Array): Promise<string> {
  return toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", copy(value))))
}

function copy(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const copied = new Uint8Array(value.byteLength)
  copied.set(value)
  return copied
}

describe("remote operation log verification", () => {
  it("accepts the deployed legacy HTTP chain format", async () => {
    await expect(
      assertRemoteLogLink(VAULT_ID, await legacyOperation(), ZERO_HASH, LogFormat.LegacyHttpV1),
    ).resolves.toBeUndefined()
  })

  it("accepts canonical CBOR log hashes", async () => {
    await expect(
      assertRemoteLogLink(
        VAULT_ID,
        await canonicalOperation(),
        ZERO_HASH,
        LogFormat.CanonicalCborV1,
      ),
    ).resolves.toBeUndefined()
  })

  it("rejects altered canonical entries", async () => {
    const valid = await canonicalOperation()

    await expect(
      assertRemoteLogLink(VAULT_ID, { ...valid, cursor: 2 }, ZERO_HASH, LogFormat.CanonicalCborV1),
    ).rejects.toThrow(/verification failed/)
  })

  it("rejects discontinuous and altered operations", async () => {
    const valid = await legacyOperation()
    await expect(
      assertRemoteLogLink(
        VAULT_ID,
        valid,
        toBase64Url(new Uint8Array(32).fill(1)),
        LogFormat.LegacyHttpV1,
      ),
    ).rejects.toThrow(/discontinuous/)

    const wire = valid.envelope as Record<string, unknown>
    const altered = {
      ...valid,
      envelope: { ...wire, envelope: toBase64Url(new Uint8Array([9])) },
    }
    await expect(
      assertRemoteLogLink(VAULT_ID, altered, ZERO_HASH, LogFormat.LegacyHttpV1),
    ).rejects.toThrow(/verification failed/)
  })
})
