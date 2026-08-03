import { Aes256Gcm, CipherSuite, DhkemX25519HkdfSha256, HkdfSha256 } from "@hpke/core"
import {
  bytesToHex,
  epochId,
  hexToBytes,
  nonce,
  revisionId,
  revisionKey,
  vaultEpochKey,
  vaultId,
  wrappedRevisionKey,
} from "@meridian/protocol"
import { describe, expect, it } from "vitest"
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  aesKwUnwrap,
  aesKwWrap,
  deriveRevisionKek,
  unwrapRevisionKey,
  wrapRevisionKey,
} from "../src/aes.js"
import { hkdfSha256 } from "../src/kdf.js"
import { asArrayBuffer } from "../src/runtime.js"
import { sign, signingKeyPairFromSeed, verify } from "../src/signatures.js"
import vector from "./vectors/hpke-x25519-aes256.json"

describe("cryptographic known-answer vectors", () => {
  it("matches RFC 5869 HKDF-SHA-256 test case 1", async () => {
    const output = await hkdfSha256(
      hexToBytes("0b".repeat(22)),
      hexToBytes("000102030405060708090a0b0c"),
      hexToBytes("f0f1f2f3f4f5f6f7f8f9"),
      42,
    )
    expect(bytesToHex(output)).toBe(
      "3cb25f25faacd57a90434f64d0362f2a" +
        "2d2d0a90cf1a5a4c5db02d56ecc4c5bf" +
        "34007208d5b887185865",
    )
  })

  it("matches RFC 8032 Ed25519 test vector 1", () => {
    const keys = signingKeyPairFromSeed(
      hexToBytes("9d61b19deffd5a60ba844af492ec2cc4" + "4449c5697b326919703bac031cae7f60"),
    )
    expect(bytesToHex(keys.publicKey)).toBe(
      "d75a980182b10ab7d54bfed3c964073a" + "0ee172f3daa62325af021a68f707511a",
    )
    const signature = sign(new Uint8Array(), keys.privateKey)
    expect(bytesToHex(signature)).toBe(
      "e5564300c360ac729086e2cc806e828a" +
        "84877f1eb8e5d974d873e06522490155" +
        "5fb8821590a33bacc61e39701cf9b46b" +
        "d25bf5f0595bbe24655141438e7a100b",
    )
    expect(verify(new Uint8Array(), signature, keys.publicKey)).toBe(true)
  })

  it("matches NIST AES-256-GCM empty-plaintext vector", async () => {
    const key = new Uint8Array(32)
    const iv = nonce(new Uint8Array(12))
    const ciphertext = await aesGcmEncrypt(key, new Uint8Array(), new Uint8Array(), iv)
    expect(bytesToHex(ciphertext)).toBe("530f8afbc74536b9a963b4f1c4cb738b")
    await expect(aesGcmDecrypt(key, ciphertext, new Uint8Array(), iv)).resolves.toEqual(
      new Uint8Array(),
    )
  })

  it("matches RFC 3394 section 4.6 AES-256-KW vector", async () => {
    const kek = hexToBytes("000102030405060708090a0b0c0d0e0f" + "101112131415161718191a1b1c1d1e1f")
    const key = hexToBytes("00112233445566778899aabbccddeeff" + "000102030405060708090a0b0c0d0e0f")
    const wrapped = await aesKwWrap(kek, key)
    expect(bytesToHex(wrapped)).toBe(
      "28c9f404c4b810f4cbccB35cfb87f826".toLowerCase() +
        "3f5786e2d80ed326cbc7f0e71a99f43b" +
        "fb988b9b7a02dd21",
    )
    await expect(aesKwUnwrap(kek, wrapped)).resolves.toEqual(key)

    const tampered = new Uint8Array(wrapped)
    tampered[0] = (tampered[0] ?? 0) ^ 1
    await expect(aesKwUnwrap(kek, tampered)).rejects.toThrow("AES-KW integrity check failed")
  })

  it("uses the generic AES-KW codec for revision keys", async () => {
    const epochKey = vaultEpochKey(new Uint8Array(32).fill(1))
    const vault = vaultId(new Uint8Array(16).fill(2))
    const epoch = epochId(new Uint8Array(16).fill(3))
    const revision = revisionId(new Uint8Array(16).fill(4))
    const key = revisionKey(new Uint8Array(32).fill(5))

    const kek = await deriveRevisionKek(epochKey, vault, epoch, revision)
    const wrapped = await wrapRevisionKey(epochKey, vault, epoch, revision, key)
    expect(wrapped).toEqual(await aesKwWrap(kek, key))
    await expect(unwrapRevisionKey(epochKey, vault, epoch, revision, wrapped)).resolves.toEqual(key)

    const tampered = wrappedRevisionKey(wrapped)
    tampered[0] = (tampered[0] ?? 0) ^ 1
    await expect(unwrapRevisionKey(epochKey, vault, epoch, revision, tampered)).rejects.toThrow(
      "Revision key unwrap failed",
    )
  })

  it("matches the CFRG selected X25519/HKDF-SHA256/AES-256-GCM vector", async () => {
    const suite = new CipherSuite({
      kem: new DhkemX25519HkdfSha256(),
      kdf: new HkdfSha256(),
      aead: new Aes256Gcm(),
    })
    const recipient = await suite.kem.deriveKeyPair(asArrayBuffer(hexToBytes(vector.ikmR)))
    expect(
      bytesToHex(new Uint8Array(await suite.kem.serializePublicKey(recipient.publicKey))),
    ).toBe(vector.publicKeyR)
    const sender = await suite.createSenderContext({
      recipientPublicKey: recipient.publicKey,
      info: asArrayBuffer(hexToBytes(vector.info)),
      ekm: asArrayBuffer(hexToBytes(vector.ikmE)),
    })
    expect(bytesToHex(new Uint8Array(sender.enc))).toBe(vector.encapsulatedKey)
    const ciphertext = await sender.seal(
      asArrayBuffer(hexToBytes(vector.plaintext)),
      asArrayBuffer(hexToBytes(vector.aad)),
    )
    expect(bytesToHex(new Uint8Array(ciphertext))).toBe(vector.ciphertext)
  })
})
