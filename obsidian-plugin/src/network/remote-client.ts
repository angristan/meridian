import type { RequestUrlParam } from "obsidian"
import type {
  CryptoPort,
  DeviceKeyMaterial,
  EncryptedBlob,
  PairingCapability,
  PairingResult,
  PairingStatus,
  RemoteChanges,
  RemoteDevice,
  RemotePort,
  SetupClaim,
  StoragePruneResult,
  StorageUsage,
  TrustedCheckpoint,
} from "../model"
import { connectCursorNotifications } from "./notifications"
import {
  assertSuccess,
  isRecord,
  optionalNumber,
  parseDevice,
  parseJsonBody,
  parseOperation,
  parsePairingResult,
  parsePairingStatus,
  requiredBoolean,
  requiredNumber,
  requiredString,
} from "./response-parsers"
import type { HttpResponse, HttpTransport } from "./transport"

export type { HttpResponse, HttpTransport } from "./transport"

const SESSION_REFRESH_SKEW_MS = 60_000

type AuthenticationContext = {
  device: DeviceKeyMaterial
  signer: CryptoPort
}

type AuthenticationAttempt = {
  authentication: AuthenticationContext
  promise: Promise<void>
}

export class MeridianRemoteClient implements RemotePort {
  private sessionToken: string | null = null
  private sessionExpiresAt = 0
  private authentication: AuthenticationContext | null = null
  private authenticationAttempt: AuthenticationAttempt | null = null

  constructor(
    endpoint: string,
    private readonly transport: HttpTransport,
    private readonly now: () => number = Date.now,
  ) {
    this.endpoint = normalizeEndpoint(endpoint)
  }

  private readonly endpoint: string

  async claim(setupSession: string, claim: SetupClaim): Promise<void> {
    if (!isRecord(claim.publicClaim))
      throw new Error("Crypto adapter returned an invalid setup claim")
    await this.jsonRequest("/v1/setup/claim", {
      method: "POST",
      body: { ...claim.publicClaim, setupSession },
      authenticated: false,
    })
  }

  async getRecoveryPackage(): Promise<string> {
    const result = await this.jsonRequest("/v1/recovery/package", {
      method: "GET",
      authenticated: false,
    })
    return requiredString(result, "encryptedRecoveryPackage")
  }

  async createRecoveryChallenge(): Promise<{ challengeId: string; challenge: string }> {
    const result = await this.jsonRequest("/v1/recovery/challenge", {
      method: "POST",
      authenticated: false,
    })
    return {
      challengeId: requiredString(result, "challengeId"),
      challenge: requiredString(result, "challenge"),
    }
  }

  async recover(publicClaim: unknown): Promise<void> {
    if (!isRecord(publicClaim)) throw new Error("Crypto adapter returned an invalid recovery claim")
    await this.jsonRequest("/v1/recovery/claim", {
      method: "POST",
      body: publicClaim,
      authenticated: false,
    })
    this.clearAuthentication()
  }

  async authenticate(device: DeviceKeyMaterial, signer: CryptoPort): Promise<void> {
    if (!this.authentication || this.authentication.device.deviceId !== device.deviceId) {
      this.invalidateSession()
      this.authentication = { device, signer }
    } else {
      this.authentication.device = device
      this.authentication.signer = signer
    }
    await this.validSessionToken()
  }

  async getChanges(after: number, checkpoint: TrustedCheckpoint | null): Promise<RemoteChanges> {
    const query = new URLSearchParams({ after: String(after) })
    if (checkpoint) query.set("afterHash", checkpoint.logHash)
    const result = await this.jsonRequest(`/v1/changes?${query.toString()}`, {
      method: "GET",
      authenticated: true,
    })
    if (!isRecord(result) || !Array.isArray(result.operations)) {
      throw new Error("Server returned an invalid change set")
    }
    const devices = result.operations.length > 0 ? await this.listDevices() : []
    const certificates = devices.map((device) => device.certificate)
    const byDevice = new Map(devices.map((device) => [device.deviceId, device.certificate]))
    const operations = result.operations.map((value) => {
      const operation = parseOperation(value)
      if (!isRecord(operation.envelope)) return operation
      const authorDeviceId = operation.envelope.authorDeviceId
      const authorCertificate =
        typeof authorDeviceId === "string" ? byDevice.get(authorDeviceId) : undefined
      return authorCertificate
        ? { ...operation, authorCertificate, certificateChain: certificates }
        : operation
    })
    const latestCursor = optionalNumber(result.latestCursor) ?? operations.at(-1)?.cursor ?? after
    return { operations, latestCursor }
  }

  async getStorageUsage(): Promise<StorageUsage> {
    const result = await this.jsonRequest("/v1/storage", { method: "GET", authenticated: true })
    return {
      totalBytes: requiredNumber(result, "totalBytes"),
      blobBytes: requiredNumber(result, "blobBytes"),
      databaseBytes: requiredNumber(result, "databaseBytes"),
      blobCount: requiredNumber(result, "blobCount"),
      operationCount: requiredNumber(result, "operationCount"),
      checkpointCount: requiredNumber(result, "checkpointCount"),
      snapshotCount: requiredNumber(result, "snapshotCount"),
      pruningAvailable: requiredBoolean(result, "canPrune"),
    }
  }

  async pruneStorage(): Promise<StoragePruneResult> {
    const result = await this.jsonRequest("/v1/storage/prune-orphans", {
      method: "POST",
      authenticated: true,
    })
    return {
      deletedBytes: requiredNumber(result, "deletedBytes"),
      deletedCount: requiredNumber(result, "deletedCount"),
      graceDays: requiredNumber(result, "graceDays"),
    }
  }

  async putBlob(blob: EncryptedBlob): Promise<void> {
    const response = await this.authenticatedRequest((sessionToken) =>
      this.transport.request({
        url: this.url(`/v1/blobs/${encodeURIComponent(blob.blobId)}`),
        method: "PUT",
        headers: this.authorizedHeaders(sessionToken, {
          "content-type": "application/octet-stream",
        }),
        body: blob.bytes,
        throw: false,
      }),
    )
    assertSuccess(response, "Blob upload")
  }

  async getBlob(blobId: string): Promise<ArrayBuffer> {
    const response = await this.authenticatedRequest((sessionToken) =>
      this.transport.request({
        url: this.url(`/v1/blobs/${encodeURIComponent(blobId)}`),
        method: "GET",
        headers: this.authorizedHeaders(sessionToken),
        throw: false,
      }),
    )
    assertSuccess(response, "Blob download")
    return response.body
  }

  async commit(
    envelope: unknown,
    idempotencyKey: string,
  ): Promise<{ cursor: number; logHash: string }> {
    if (!isRecord(envelope)) throw new Error("Crypto adapter returned an invalid operation")
    const result = await this.jsonRequest("/v1/operations", {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: envelope,
      authenticated: true,
    })
    return {
      cursor: requiredNumber(result, "cursor"),
      logHash: requiredString(result, "chainHash"),
    }
  }

  async listDevices(): Promise<RemoteDevice[]> {
    const result = await this.jsonRequest("/v1/devices", { method: "GET", authenticated: true })
    if (!isRecord(result) || !Array.isArray(result.devices)) {
      throw new Error("Server returned an invalid device registry")
    }
    return result.devices.map(parseDevice)
  }

  async updateDeviceDescriptor(descriptor: {
    deviceName: string
    platform: string
  }): Promise<void> {
    await this.jsonRequest("/v1/device/descriptor", {
      method: "PUT",
      body: descriptor,
      authenticated: true,
    })
  }

  async revokeDevice(
    targetDeviceId: string,
    envelope: unknown,
  ): Promise<{ cursor: number; logHash: string }> {
    if (!isRecord(envelope)) throw new Error("Crypto adapter returned an invalid revocation")
    const result = await this.jsonRequest(
      `/v1/devices/${encodeURIComponent(targetDeviceId)}/revoke`,
      {
        method: "POST",
        body: { operation: envelope },
        authenticated: true,
      },
    )
    return {
      cursor: requiredNumber(result, "cursor"),
      logHash: requiredString(result, "chainHash"),
    }
  }

  async isDeviceAuthorized(deviceId: string): Promise<boolean> {
    const response = await this.transport.request({
      url: this.url("/v1/auth/challenge"),
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceId }),
      throw: false,
    })
    if (response.status === 404) {
      const body = parseJsonBody(response, "Device authorization check")
      if (isRecord(body) && isRecord(body.error) && body.error.code === "device_not_found") {
        return false
      }
      throw new Error("Device authorization check returned an invalid not-found response")
    }
    assertSuccess(response, "Device authorization check")
    return true
  }

  async createPairing(): Promise<PairingCapability> {
    const result = await this.jsonRequest("/v1/pairings", {
      method: "POST",
      body: { expiresInSeconds: 300 },
      authenticated: true,
    })
    return {
      pairingId: requiredString(result, "pairingId"),
      capability: requiredString(result, "capability"),
      vaultId: requiredString(result, "vaultId"),
      expiresAt: requiredNumber(result, "expiresAt"),
    }
  }

  async getPairingStatus(pairingId: string): Promise<PairingStatus> {
    return parsePairingStatus(
      await this.jsonRequest(`/v1/pairings/${encodeURIComponent(pairingId)}`, {
        method: "GET",
        authenticated: true,
      }),
    )
  }

  async getPairingProgress(pairingId: string, capability: string): Promise<PairingStatus> {
    return parsePairingStatus(
      await this.jsonRequest(`/v1/pairings/${encodeURIComponent(pairingId)}/status`, {
        method: "POST",
        body: { capability },
        authenticated: false,
      }),
    )
  }

  async joinPairing(pairingId: string, payload: unknown): Promise<PairingResult> {
    return parsePairingResult(
      await this.jsonRequest(`/v1/pairings/${encodeURIComponent(pairingId)}/join`, {
        method: "POST",
        body: payload,
        authenticated: false,
      }),
    )
  }

  async approvePairing(pairingId: string, payload: unknown): Promise<PairingResult> {
    return parsePairingResult(
      await this.jsonRequest(`/v1/pairings/${encodeURIComponent(pairingId)}/approve`, {
        method: "POST",
        body: payload,
        authenticated: true,
      }),
    )
  }

  async releasePairing(pairingId: string, payload: unknown): Promise<PairingResult> {
    return parsePairingResult(
      await this.jsonRequest(`/v1/pairings/${encodeURIComponent(pairingId)}/release`, {
        method: "POST",
        body: payload,
        authenticated: true,
      }),
    )
  }

  async getPairingResult(pairingId: string, capability: string): Promise<PairingResult> {
    return parsePairingResult(
      await this.jsonRequest(`/v1/pairings/${encodeURIComponent(pairingId)}/result`, {
        method: "POST",
        body: { capability },
        authenticated: false,
      }),
    )
  }

  async confirmPairingOwner(pairingId: string): Promise<PairingResult> {
    return parsePairingResult(
      await this.jsonRequest(`/v1/pairings/${encodeURIComponent(pairingId)}/confirm-owner`, {
        method: "POST",
        body: {},
        authenticated: true,
      }),
    )
  }

  async confirmPairingCandidate(pairingId: string, payload: unknown): Promise<PairingResult> {
    return parsePairingResult(
      await this.jsonRequest(`/v1/pairings/${encodeURIComponent(pairingId)}/confirm-candidate`, {
        method: "POST",
        body: payload,
        authenticated: false,
      }),
    )
  }

  async completePairing(pairingId: string, payload: unknown): Promise<PairingResult> {
    return parsePairingResult(
      await this.jsonRequest(`/v1/pairings/${encodeURIComponent(pairingId)}/complete`, {
        method: "POST",
        body: payload,
        authenticated: false,
      }),
    )
  }

  async cancelPairing(pairingId: string, capability: string): Promise<PairingResult> {
    return parsePairingResult(
      await this.jsonRequest(`/v1/pairings/${encodeURIComponent(pairingId)}/cancel`, {
        method: "POST",
        body: { capability },
        authenticated: false,
      }),
    )
  }

  async rejectPairing(pairingId: string): Promise<PairingResult> {
    return parsePairingResult(
      await this.jsonRequest(`/v1/pairings/${encodeURIComponent(pairingId)}/reject`, {
        method: "POST",
        body: {},
        authenticated: true,
      }),
    )
  }

  connectNotifications(
    after: number,
    onCursor: (cursor: number) => void,
    onState: (connected: boolean) => void,
  ): () => void {
    if (!this.authentication) return () => onState(false)
    return connectCursorNotifications(
      this.endpoint,
      () => this.validSessionToken(),
      after,
      onCursor,
      onState,
    )
  }

  private async jsonRequest(
    path: string,
    options: {
      method: string
      headers?: Record<string, string>
      body?: unknown
      authenticated: boolean
    },
  ): Promise<unknown> {
    const body = options.body === undefined ? undefined : JSON.stringify(options.body)
    const request = (sessionToken?: string): Promise<HttpResponse> => {
      const headers = {
        ...(sessionToken ? { authorization: `Bearer ${sessionToken}` } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...options.headers,
      }
      const request: RequestUrlParam = {
        url: this.url(path),
        method: options.method,
        headers,
        throw: false,
      }
      if (body !== undefined) request.body = body
      return this.transport.request(request)
    }
    const response = options.authenticated
      ? await this.authenticatedRequest((sessionToken) => request(sessionToken))
      : await request()
    assertSuccess(response, "Meridian request")
    return parseJsonBody(response, "Meridian request")
  }

  private async authenticatedRequest(
    request: (sessionToken: string) => Promise<HttpResponse>,
  ): Promise<HttpResponse> {
    const initialToken = await this.validSessionToken()
    const initialResponse = await request(initialToken)
    if (initialResponse.status !== 401) return initialResponse

    if (this.sessionToken === initialToken) this.invalidateSession()
    return request(await this.validSessionToken())
  }

  private async validSessionToken(): Promise<string> {
    if (this.sessionToken && this.sessionExpiresAt - this.now() > SESSION_REFRESH_SKEW_MS) {
      return this.sessionToken
    }
    await this.refreshSession()
    if (!this.sessionToken) throw new Error("Device authentication did not return a session")
    return this.sessionToken
  }

  private async refreshSession(): Promise<void> {
    const authentication = this.authentication
    if (!authentication) throw new Error("Device is not authenticated")
    if (this.authenticationAttempt?.authentication === authentication) {
      return this.authenticationAttempt.promise
    }

    const refresh = async () => {
      const challengeResult = await this.jsonRequest("/v1/auth/challenge", {
        method: "POST",
        body: { deviceId: authentication.device.deviceId },
        authenticated: false,
      })
      const challenge = requiredString(challengeResult, "challenge")
      const challengeId = requiredString(challengeResult, "challengeId")
      const proof = await authentication.signer.signChallenge(authentication.device, {
        challengeId,
        challenge,
      })
      const sessionResult = await this.jsonRequest("/v1/auth/session", {
        method: "POST",
        body: {
          ...proof,
          supportedLogFormats: ["legacy-http-v1", "canonical-cbor-v1"],
        },
        authenticated: false,
      })
      const sessionToken = requiredString(sessionResult, "sessionToken")
      const sessionExpiresAt = requiredNumber(sessionResult, "expiresAt")
      if (this.authentication !== authentication) {
        throw new Error("Device authentication changed during session creation")
      }
      this.sessionToken = sessionToken
      this.sessionExpiresAt = sessionExpiresAt
    }

    const promise = refresh().finally(() => {
      if (this.authenticationAttempt?.authentication === authentication) {
        this.authenticationAttempt = null
      }
    })
    this.authenticationAttempt = { authentication, promise }
    return promise
  }

  private invalidateSession(): void {
    this.sessionToken = null
    this.sessionExpiresAt = 0
  }

  private clearAuthentication(): void {
    this.invalidateSession()
    this.authentication = null
  }

  private authorizedHeaders(
    sessionToken: string,
    extra: Record<string, string> = {},
  ): Record<string, string> {
    return { authorization: `Bearer ${sessionToken}`, ...extra }
  }

  private url(path: string): string {
    return `${this.endpoint}${path}`
  }
}

export function normalizeEndpoint(value: string): string {
  const url = new URL(value.trim())
  const localDevelopment = url.hostname === "localhost" || url.hostname === "127.0.0.1"
  if (url.protocol !== "https:" && !(localDevelopment && url.protocol === "http:")) {
    throw new Error("Meridian endpoint must use HTTPS")
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Meridian endpoint cannot include credentials, query parameters, or fragments")
  }
  return `${url.origin}${url.pathname.replace(/\/$/, "")}`
}
