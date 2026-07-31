import { httpOperationSigningBytes, logChainSigningBytes } from "@meridian/protocol"
import { describe, expect, it } from "vitest"
import type { RemoteOperation } from "../src/model"
import { toBase64Url } from "../src/platform/bytes"
import { assertRemoteLogLink } from "../src/sync/log-verifier"

const ZERO_HASH = toBase64Url(new Uint8Array(32))

async function operation(): Promise<RemoteOperation> {
  const envelope = toBase64Url(new Uint8Array([1, 2, 3]))
  const signature = toBase64Url(new Uint8Array(64))
  const operationMessage = httpOperationSigningBytes({
    operationId: "operation-id",
    authorDeviceId: "author-device",
    epochId: "epoch-id",
    type: "revision",
    envelope: new Uint8Array([1, 2, 3]),
  })
  const chainHash = toBase64Url(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        copy(logChainSigningBytes(new Uint8Array(32), operationMessage, new Uint8Array(64))),
      ),
    ),
  )
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

function copy(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const copied = new Uint8Array(value.byteLength)
  copied.set(value)
  return copied
}

describe("remote operation log verification", () => {
  it("accepts the canonical deployed HTTP chain format", async () => {
    await expect(assertRemoteLogLink(await operation(), ZERO_HASH)).resolves.toBeUndefined()
  })

  it("rejects discontinuous and altered operations", async () => {
    const valid = await operation()
    await expect(
      assertRemoteLogLink(valid, toBase64Url(new Uint8Array(32).fill(1))),
    ).rejects.toThrow(/discontinuous/)

    const wire = valid.envelope as Record<string, unknown>
    const altered = {
      ...valid,
      envelope: { ...wire, envelope: toBase64Url(new Uint8Array([9])) },
    }
    await expect(assertRemoteLogLink(altered, ZERO_HASH)).rejects.toThrow(/verification failed/)
  })
})
