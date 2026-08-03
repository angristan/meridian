import {
  AuthChallengeResponseSchema,
  AuthSessionResponseSchema,
  ChangesResponseSchema,
  DeviceDescriptorResponseSchema,
  DeviceListResponseSchema,
  ErrorResponseSchema,
  OperationReceiptResponseSchema,
  PairingCapabilityResponseSchema,
  PairingResultResponseSchema,
  PairingStatusResponseSchema,
  RecoveryChallengeResponseSchema,
  RecoveryClaimResponseSchema,
  RecoveryPackageResponseSchema,
  RetentionAcknowledgementResponseSchema,
  SetupClaimResponseSchema,
  StoragePruneResponseSchema,
  StorageResponseSchema,
} from "@meridian/protocol"
import type { RequestUrlParam } from "obsidian"
import type {
  CryptoPort,
  DeviceKeyMaterial,
  EncryptedBlob,
  PairingCapability,
  PairingResult,
  PairingStatus,
  RecoveryPackageMaterial,
  RemoteChanges,
  RemoteDevice,
  RemotePort,
  RemoteStorageUsage,
  RetentionAcknowledgement,
  SetupClaim,
  StoragePruneResult,
  TrustedCheckpoint,
} from "../model"
import { connectCursorNotifications } from "./notifications"
import { assertSuccess, decodeResponse, isRecord, parseJsonBody } from "./response-parsers"
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
    decodeResponse(
      SetupClaimResponseSchema,
      await this.jsonRequest("/v1/setup/claim", {
        method: "POST",
        body: { ...claim.publicClaim, setupSession },
        authenticated: false,
      }),
      "Setup claim",
    )
  }

  async getRecoveryPackage(): Promise<RecoveryPackageMaterial> {
    const result = decodeResponse(
      RecoveryPackageResponseSchema,
      await this.jsonRequest("/v1/recovery/package", {
        method: "GET",
        authenticated: false,
      }),
      "Recovery package",
    )
    return {
      encryptedRecoveryPackage: result.encryptedRecoveryPackage,
      recoveryStateId: result.recoveryStateId,
    }
  }

  async createRecoveryChallenge(): Promise<{ challengeId: string; challenge: string }> {
    const result = decodeResponse(
      RecoveryChallengeResponseSchema,
      await this.jsonRequest("/v1/recovery/challenge", {
        method: "POST",
        authenticated: false,
      }),
      "Recovery challenge",
    )
    return { challengeId: result.challengeId, challenge: result.challenge }
  }

  async recover(publicClaim: unknown): Promise<void> {
    if (!isRecord(publicClaim)) throw new Error("Crypto adapter returned an invalid recovery claim")
    decodeResponse(
      RecoveryClaimResponseSchema,
      await this.jsonRequest("/v1/recovery/claim", {
        method: "POST",
        body: publicClaim,
        authenticated: false,
      }),
      "Recovery claim",
    )
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
    const result = decodeResponse(
      ChangesResponseSchema,
      await this.jsonRequest(`/v1/changes?${query.toString()}`, {
        method: "GET",
        authenticated: true,
      }),
      "Change set",
    )
    const devices = result.operations.length > 0 ? await this.listDevices() : []
    const certificates = devices.map((device) => device.certificate)
    const byDevice = new Map(devices.map((device) => [device.deviceId, device.certificate]))
    const operations = result.operations.map((envelope) => {
      const operation = {
        cursor: envelope.cursor,
        logHash: envelope.chainHash,
        envelope,
      }
      const authorCertificate = byDevice.get(envelope.authorDeviceId)
      return authorCertificate
        ? { ...operation, authorCertificate, certificateChain: certificates }
        : operation
    })
    return { operations, latestCursor: result.latestCursor }
  }

  async getStorageUsage(): Promise<RemoteStorageUsage> {
    const result = decodeResponse(
      StorageResponseSchema,
      await this.jsonRequest("/v1/storage", { method: "GET", authenticated: true }),
      "Storage usage",
    )
    return {
      totalBytes: result.totalBytes,
      blobBytes: result.blobBytes,
      databaseBytes: result.databaseBytes,
      blobCount: result.blobCount,
      reservedBlobBytes: result.reservedBlobBytes,
      operationCount: result.operationCount,
      checkpointCount: result.checkpointCount,
      snapshotCount: result.snapshotCount,
      retentionMode: result.retentionMode,
      activeDeviceCount: result.activeDeviceCount,
      acknowledgedDeviceCount: result.acknowledgedDeviceCount,
      minimumAcknowledgedCursor: result.minimumAcknowledgedCursor,
      pruningAvailable: result.canPrune,
    }
  }

  async acknowledgeRetention(acknowledgement: RetentionAcknowledgement): Promise<void> {
    decodeResponse(
      RetentionAcknowledgementResponseSchema,
      await this.jsonRequest("/v1/retention/acknowledgement", {
        method: "PUT",
        body: acknowledgement,
        authenticated: true,
      }),
      "Retention acknowledgement",
    )
  }

  async pruneStorage(): Promise<StoragePruneResult> {
    return decodeResponse(
      StoragePruneResponseSchema,
      await this.jsonRequest("/v1/storage/prune-orphans", {
        method: "POST",
        authenticated: true,
      }),
      "Storage pruning",
    )
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
    const result = decodeResponse(
      OperationReceiptResponseSchema,
      await this.jsonRequest("/v1/operations", {
        method: "POST",
        headers: { "idempotency-key": idempotencyKey },
        body: envelope,
        authenticated: true,
      }),
      "Operation commit",
    )
    return { cursor: result.cursor, logHash: result.chainHash }
  }

  async listDevices(): Promise<RemoteDevice[]> {
    const result = decodeResponse(
      DeviceListResponseSchema,
      await this.jsonRequest("/v1/devices", { method: "GET", authenticated: true }),
      "Device registry",
    )
    return result.devices.map((device) => ({
      deviceId: device.deviceId,
      signingPublicKey: device.signingPublicKey,
      hpkePublicKey: device.hpkePublicKey,
      certificate: device.certificate,
      role: device.role,
      authorizedAt: device.authorizedAt,
      revokedAt: device.revokedAt,
      deviceName: device.deviceName ?? null,
      platform: device.platform ?? null,
    }))
  }

  async updateDeviceDescriptor(descriptor: {
    deviceName: string
    platform: string
  }): Promise<void> {
    decodeResponse(
      DeviceDescriptorResponseSchema,
      await this.jsonRequest("/v1/device/descriptor", {
        method: "PUT",
        body: descriptor,
        authenticated: true,
      }),
      "Device descriptor update",
    )
  }

  async revokeDevice(
    targetDeviceId: string,
    envelope: unknown,
  ): Promise<{ cursor: number; logHash: string }> {
    if (!isRecord(envelope)) throw new Error("Crypto adapter returned an invalid revocation")
    const result = decodeResponse(
      OperationReceiptResponseSchema,
      await this.jsonRequest(`/v1/devices/${encodeURIComponent(targetDeviceId)}/revoke`, {
        method: "POST",
        body: { operation: envelope },
        authenticated: true,
      }),
      "Device revocation",
    )
    return { cursor: result.cursor, logHash: result.chainHash }
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
      const value = parseJsonBody(response, "Device authorization check")
      try {
        const body = decodeResponse(ErrorResponseSchema, value, "Device authorization check")
        if (body.error.code === "device_not_found") return false
      } catch {
        // Normalize malformed 404 bodies below.
      }
      throw new Error("Device authorization check returned an invalid not-found response")
    }
    assertSuccess(response, "Device authorization check")
    return true
  }

  async createPairing(): Promise<PairingCapability> {
    return decodeResponse(
      PairingCapabilityResponseSchema,
      await this.jsonRequest("/v1/pairings", {
        method: "POST",
        body: { expiresInSeconds: 300 },
        authenticated: true,
      }),
      "Pairing creation",
    )
  }

  async getPairingStatus(pairingId: string): Promise<PairingStatus> {
    return pairingStatus(
      await this.jsonRequest(`/v1/pairings/${encodeURIComponent(pairingId)}`, {
        method: "GET",
        authenticated: true,
      }),
    )
  }

  async getPairingProgress(pairingId: string, capability: string): Promise<PairingStatus> {
    return pairingStatus(
      await this.jsonRequest(`/v1/pairings/${encodeURIComponent(pairingId)}/status`, {
        method: "POST",
        body: { capability },
        authenticated: false,
      }),
    )
  }

  async joinPairing(pairingId: string, payload: unknown): Promise<PairingResult> {
    return this.pairingResultRequest(pairingId, "join", payload, { authenticated: false })
  }

  async approvePairing(pairingId: string, payload: unknown): Promise<PairingResult> {
    return this.pairingResultRequest(pairingId, "approve", payload, { authenticated: true })
  }

  async releasePairing(pairingId: string, payload: unknown): Promise<PairingResult> {
    return this.pairingResultRequest(pairingId, "release", payload, { authenticated: true })
  }

  async getPairingResult(pairingId: string, capability: string): Promise<PairingResult> {
    return this.pairingResultRequest(pairingId, "result", { capability }, { authenticated: false })
  }

  async confirmPairingOwner(pairingId: string): Promise<PairingResult> {
    return this.pairingResultRequest(pairingId, "confirm-owner", {}, { authenticated: true })
  }

  async confirmPairingCandidate(pairingId: string, payload: unknown): Promise<PairingResult> {
    return this.pairingResultRequest(pairingId, "confirm-candidate", payload, {
      authenticated: false,
    })
  }

  async completePairing(pairingId: string, payload: unknown): Promise<PairingResult> {
    return this.pairingResultRequest(pairingId, "complete", payload, { authenticated: false })
  }

  async cancelPairing(pairingId: string, capability: string): Promise<PairingResult> {
    return this.pairingResultRequest(
      pairingId,
      "cancel",
      { capability },
      {
        authenticated: false,
      },
    )
  }

  async rejectPairing(pairingId: string): Promise<PairingResult> {
    return this.pairingResultRequest(pairingId, "reject", {}, { authenticated: true })
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

  private async pairingResultRequest(
    pairingId: string,
    action:
      | "join"
      | "approve"
      | "release"
      | "result"
      | "confirm-owner"
      | "confirm-candidate"
      | "complete"
      | "cancel"
      | "reject",
    body: unknown,
    options: { authenticated: boolean },
  ): Promise<PairingResult> {
    return pairingResult(
      await this.jsonRequest(`/v1/pairings/${encodeURIComponent(pairingId)}/${action}`, {
        method: "POST",
        body,
        authenticated: options.authenticated,
      }),
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
      const challengeResult = decodeResponse(
        AuthChallengeResponseSchema,
        await this.jsonRequest("/v1/auth/challenge", {
          method: "POST",
          body: { deviceId: authentication.device.deviceId },
          authenticated: false,
        }),
        "Authentication challenge",
      )
      const proof = await authentication.signer.signChallenge(authentication.device, {
        challengeId: challengeResult.challengeId,
        challenge: challengeResult.challenge,
      })
      const sessionResult = decodeResponse(
        AuthSessionResponseSchema,
        await this.jsonRequest("/v1/auth/session", {
          method: "POST",
          body: proof,
          authenticated: false,
        }),
        "Authentication session",
      )
      if (this.authentication !== authentication) {
        throw new Error("Device authentication changed during session creation")
      }
      this.sessionToken = sessionResult.sessionToken
      this.sessionExpiresAt = sessionResult.expiresAt
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

function pairingStatus(value: unknown): PairingStatus {
  const result = decodeResponse(PairingStatusResponseSchema, value, "Pairing status")
  return {
    pairingId: result.pairingId,
    status: result.status,
    expiresAt: result.expiresAt,
    ownerConfirmed: result.ownerConfirmed,
    candidateConfirmed: result.candidateConfirmed,
    ...(result.requestedAt === undefined || result.requestedAt === null
      ? {}
      : { requestedAt: result.requestedAt }),
    ...(result.candidateConfirmation === undefined
      ? {}
      : { candidateConfirmation: result.candidateConfirmation }),
    ...(result.candidate === undefined
      ? {}
      : { candidate: result.candidate, candidatePackage: JSON.stringify(result.candidate) }),
  }
}

function pairingResult(value: unknown): PairingResult {
  const result = decodeResponse(PairingResultResponseSchema, value, "Pairing result")
  return {
    pairingId: result.pairingId,
    status: result.status,
    ...(result.deviceId ? { deviceId: result.deviceId } : {}),
    ...(result.certificate ? { certificate: result.certificate } : {}),
    ...(result.transcriptHash ? { transcriptHash: result.transcriptHash } : {}),
    ...(result.verificationPreview ? { verificationPreview: result.verificationPreview } : {}),
    ...(result.approvalSignature ? { approvalSignature: result.approvalSignature } : {}),
    ...(result.hpkeTransfer ? { hpkeTransfer: result.hpkeTransfer } : {}),
    ...(result.verificationStartedAt === undefined || result.verificationStartedAt === null
      ? {}
      : { verificationStartedAt: result.verificationStartedAt }),
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
