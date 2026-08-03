import {
  type PairingApproval,
  PairingApprovalSchema,
  PairingCandidateConfirmationSchema,
  type PairingJoin,
  PairingJoinSchema,
  type PairingRelease,
  PairingReleaseSchema,
} from "@meridian/protocol"
import * as Schema from "effect/Schema"
import type { CryptoPort, MeridianSettings, PairingInvitation, PairingStatus } from "../model"
import { ObsidianHttpTransport } from "../network/obsidian-transport"
import { MeridianRemoteClient, normalizeEndpoint } from "../network/remote-client"
import { MeridianHttpError } from "../network/response-parsers"
import { pollUntil } from "../platform/polling"
import type { SyncController } from "../sync/controller"
import { defaultDeviceName, defaultDevicePlatform } from "./device-descriptor"
import { confirmRemotePairingCompletion } from "./pairing-completion"
import { createPairingDeepLink, hasConfiguredMeridianIdentity } from "./pairing-link"
import type { MeridianSecretStorage } from "./secret-storage"
import { withoutMeridianIdentity } from "./settings-state"

type PairingController = Pick<
  SyncController,
  | "confirmPairingOwner"
  | "createPairing"
  | "pairingStatus"
  | "preparePairingApproval"
  | "rejectPairing"
  | "releasePairing"
  | "submitPairingApproval"
>

export type PairingUiCapability = Pick<
  PairingCoordinator,
  | "createLink"
  | "status"
  | "progress"
  | "approve"
  | "confirmOwner"
  | "completeOwner"
  | "reject"
  | "join"
  | "prepareVerification"
  | "finish"
  | "completePending"
  | "cancel"
>

export class PairingCoordinator {
  private readonly polling = new AbortController()

  constructor(
    private readonly getController: () => PairingController | null,
    private readonly getSettings: () => MeridianSettings,
    private readonly setSettings: (settings: MeridianSettings) => void,
    private readonly saveSettings: () => Promise<void>,
    private readonly initializeExistingConnection: () => Promise<void>,
    private readonly crypto: CryptoPort,
    private readonly secrets: MeridianSecretStorage,
  ) {}

  stop(): void {
    this.polling.abort()
  }

  async createLink(): Promise<PairingInvitation> {
    const controller = this.controller()
    const pairing = await controller.createPairing()
    return {
      ...pairing,
      link: createPairingDeepLink(this.getSettings().endpoint, pairing),
    }
  }

  async status(pairingId: string): Promise<PairingStatus> {
    return this.controller().pairingStatus(pairingId)
  }

  async progress(endpoint: string, pairingId: string, capability: string): Promise<PairingStatus> {
    return this.remote(endpoint).getPairingProgress(pairingId, capability)
  }

  async approve(pairingId: string): Promise<string> {
    const controller = this.controller()
    const existing = this.secrets.getPendingPairingRelease(pairingId)
    if (existing) {
      const withheld = this.pendingRelease(pairingId)
      const status = await controller.pairingStatus(pairingId)
      if (status.candidatePackage !== withheld.candidatePackage) {
        throw new Error("Joining device identity changed during approval")
      }
      if (status.status === "joined") {
        await controller.submitPairingApproval(pairingId, withheld.approvalPayload)
      } else if (
        status.status !== "verifying" &&
        status.status !== "confirmed" &&
        status.status !== "released" &&
        status.status !== "completed"
      ) {
        throw new Error(status.status === "canceled" ? "Pairing was canceled" : "Pairing changed")
      }
      return withheld.verificationPhrase
    }

    const prepared = await controller.preparePairingApproval(pairingId)
    this.secrets.setDeviceKeyBundle(this.getSettings().deviceId, prepared.deviceKeyBundle)
    this.secrets.setPendingPairingRelease(
      pairingId,
      JSON.stringify({
        candidatePackage: prepared.candidatePackage,
        approvalPayload: prepared.approval.payload,
        releasePayload: prepared.approval.releasePayload,
        transferHash: prepared.approval.transferHash,
        verificationPhrase: prepared.approval.verificationPhrase,
      }),
    )
    await controller.submitPairingApproval(pairingId, prepared.approval.payload)
    return prepared.approval.verificationPhrase
  }

  async confirmOwner(pairingId: string): Promise<void> {
    const controller = this.controller()
    await controller.confirmPairingOwner(pairingId)
    let status = await controller.pairingStatus(pairingId)
    if (status.status === "verifying") {
      status = await pollUntil({
        read: () => controller.pairingStatus(pairingId),
        isDone: (value) => value.status !== "verifying",
        expiresAt: status.expiresAt,
        signal: this.polling.signal,
      })
    }
    if (status.status === "released" || status.status === "completed") return
    if (
      status.status !== "confirmed" ||
      !status.candidateConfirmation ||
      !status.candidatePackage
    ) {
      throw new Error(status.status === "canceled" ? "Pairing was canceled" : "Pairing changed")
    }
    const withheld = this.pendingRelease(pairingId)
    if (withheld.candidatePackage !== status.candidatePackage) {
      throw new Error("Joining device identity changed during verification")
    }
    if (status.candidateConfirmation.transferHash !== withheld.transferHash) {
      throw new Error("Joining device confirmed a different encrypted transfer")
    }
    const confirmationValid = await this.crypto.verifyPairingConfirmation(
      withheld.candidatePackage,
      status.candidateConfirmation,
    )
    if (!confirmationValid) throw new Error("Joining device confirmation is invalid")
    await controller.releasePairing(pairingId, withheld.releasePayload)
  }

  completeOwner(pairingId: string): void {
    this.secrets.clearPendingPairing(pairingId)
  }

  async reject(pairingId: string): Promise<void> {
    const controller = this.controller()
    try {
      await controller.rejectPairing(pairingId)
    } finally {
      this.secrets.clearPendingPairing(pairingId)
    }
  }

  async join(
    endpoint: string,
    pairingId: string,
    capability: string,
    vaultId: string,
    expiresAt: number,
  ): Promise<void> {
    if (hasConfiguredMeridianIdentity(this.getSettings())) {
      throw new Error(
        "Meridian is already set up in this local vault. Remove this device before pairing again.",
      )
    }
    const remote = this.remote(endpoint)
    const progress = await remote.getPairingProgress(pairingId, capability)
    if (progress.status !== "pending") {
      if (progress.status === "canceled") {
        this.secrets.clearPendingPairing(pairingId)
        throw new Error("Pairing was canceled. Scan a new code to retry")
      }
      if (this.secrets.getPendingPairing(pairingId)) return
      throw new Error("This pairing request was joined by another local attempt")
    }
    const existingJoin = this.secrets.getPendingPairingJoin(pairingId)
    if (this.secrets.getPendingPairing(pairingId) && existingJoin) {
      await this.submitJoin(
        remote,
        pairingId,
        capability,
        Schema.decodeUnknownSync(PairingJoinSchema)(JSON.parse(existingJoin)),
      )
      return
    }
    const joining = await this.crypto.createPairingJoin(
      {
        pairingId,
        capability,
        vaultId,
        expiresAt,
      },
      {
        deviceName: this.getSettings().deviceName || defaultDeviceName(),
        platform: defaultDevicePlatform(),
      },
    )
    this.secrets.setPendingPairing(pairingId, joining.pendingSecret)
    this.secrets.setPendingPairingJoin(pairingId, JSON.stringify(joining.payload))
    await this.submitJoin(remote, pairingId, capability, joining.payload)
  }

  async prepareVerification(
    endpoint: string,
    pairingId: string,
    capability: string,
  ): Promise<string> {
    const pendingSecret = this.secrets.getPendingPairing(pairingId)
    if (!pendingSecret) throw new Error("Pending pairing keys are missing")
    const result = await this.remote(endpoint).getPairingResult(pairingId, capability)
    if (
      (result.status !== "verifying" && result.status !== "confirmed") ||
      !result.verificationPreview ||
      !result.transcriptHash
    ) {
      throw new Error("The existing device has not prepared verification yet")
    }
    const verification = await this.crypto.inspectPairingVerification(
      pendingSecret,
      result.verificationPreview,
    )
    if (verification.transferHash !== result.transcriptHash) {
      throw new Error("Pairing verification preview does not match the encrypted transfer")
    }
    return verification.verificationPhrase
  }

  async finish(endpoint: string, pairingId: string, capability: string): Promise<void> {
    const normalizedEndpoint = normalizeEndpoint(endpoint)
    const pendingCompletion = this.getSettings().pendingPairingCompletion
    if (pendingCompletion) {
      if (
        pendingCompletion.endpoint !== normalizedEndpoint ||
        pendingCompletion.pairingId !== pairingId ||
        this.pendingCompletionPayload(pendingCompletion.pairingId).capability !== capability
      ) {
        throw new Error("Another pairing completion is already pending in this vault")
      }
      await this.completePending()
      return
    }
    if (hasConfiguredMeridianIdentity(this.getSettings())) {
      throw new Error("Meridian is already set up and connected in this vault.")
    }
    const pendingSecret = this.secrets.getPendingPairing(pairingId)
    if (!pendingSecret) throw new Error("Pending pairing keys are missing")
    const remote = this.remote(normalizedEndpoint)
    let result = await remote.getPairingResult(pairingId, capability)
    if (!result.verificationPreview || !result.transcriptHash) {
      throw new Error("Pairing verification material is missing")
    }
    const verification = await this.crypto.inspectPairingVerification(
      pendingSecret,
      result.verificationPreview,
    )
    if (verification.transferHash !== result.transcriptHash) {
      throw new Error("Pairing verification preview does not match the encrypted transfer")
    }
    const confirmation = await this.crypto.createPairingConfirmation(
      pendingSecret,
      verification.transferHash,
    )
    result = await remote.confirmPairingCandidate(pairingId, {
      capability,
      ...confirmation,
    })
    if (result.status === "verifying" || result.status === "confirmed") {
      result = await pollUntil({
        read: () => remote.getPairingResult(pairingId, capability),
        isDone: (value) => value.status !== "verifying" && value.status !== "confirmed",
        expiresAt: this.pairingExpiry(pendingSecret),
        signal: this.polling.signal,
      })
    }
    if ((result.status === "released" || result.status === "completed") && !result.hpkeTransfer) {
      result = await remote.getPairingResult(pairingId, capability)
    }
    if (result.status !== "released" && result.status !== "completed") {
      throw new Error(
        result.status === "canceled" ? "Pairing was canceled" : "Pairing was not released",
      )
    }
    let hpkeTransfer = this.secrets.getPendingPairingResult(pairingId)
    if (!hpkeTransfer) {
      if (!result.hpkeTransfer) throw new Error("Encrypted pairing transfer is missing")
      hpkeTransfer = result.hpkeTransfer
      this.secrets.setPendingPairingResult(pairingId, hpkeTransfer)
    }
    const paired = await this.crypto.consumePairingResult(
      pendingSecret,
      hpkeTransfer,
      verification.verificationPhrase,
      verification.transferHash,
    )
    this.secrets.setDeviceKeyBundle(paired.deviceId, paired.keyBundle)
    this.secrets.setPendingPairingCompletion(
      pairingId,
      JSON.stringify({ capability, ...paired.completion }),
    )
    this.setSettings({
      ...this.getSettings(),
      enabled: false,
      endpoint: normalizedEndpoint,
      vaultId: paired.vaultId,
      deviceId: paired.deviceId,
      pendingPairingCompletion: {
        endpoint: normalizedEndpoint,
        pairingId,
        vaultId: paired.vaultId,
        deviceId: paired.deviceId,
        expiresAt: this.pairingExpiry(pendingSecret),
      },
    })
    await this.saveSettings()
    await this.completePending()
  }

  async completePending(): Promise<void> {
    const pending = this.getSettings().pendingPairingCompletion
    if (!pending) return
    const completion = this.pendingCompletionPayload(pending.pairingId)
    const remote = this.remote(pending.endpoint)
    try {
      await confirmRemotePairingCompletion({
        complete: async () => {
          const completed = await remote.completePairing(pending.pairingId, completion)
          if (completed.status !== "completed") {
            throw new Error("Pairing completion was not accepted")
          }
        },
        isDeviceAuthorized: () => remote.isDeviceAuthorized(pending.deviceId),
      })
    } catch (error) {
      if (
        Date.now() < pending.expiresAt ||
        !(error instanceof MeridianHttpError) ||
        (error.code !== "pairing_expired" && error.code !== "pairing_not_found")
      ) {
        throw error
      }
      let authorized: boolean
      try {
        authorized = await remote.isDeviceAuthorized(pending.deviceId)
      } catch {
        throw error
      }
      if (authorized) throw error

      const pendingSettings = this.getSettings()
      this.setSettings(withoutMeridianIdentity(pendingSettings))
      try {
        await this.saveSettings()
      } catch (saveError) {
        this.setSettings(pendingSettings)
        throw saveError
      }
      this.secrets.clearDeviceKeyBundle(pending.deviceId)
      this.secrets.clearPendingPairing(pending.pairingId)
      throw new Error("Pairing expired before authorization. Create a new code and try again")
    }

    const pendingSettings = this.getSettings()
    this.setSettings({
      ...pendingSettings,
      enabled: true,
      endpoint: pending.endpoint,
      vaultId: pending.vaultId,
      deviceId: pending.deviceId,
      pendingPairingCompletion: null,
    })
    try {
      await this.saveSettings()
    } catch (error) {
      this.setSettings(pendingSettings)
      throw error
    }
    this.secrets.clearPendingPairing(pending.pairingId)
    await this.initializeExistingConnection()
  }

  async cancel(endpoint: string, pairingId: string, capability: string): Promise<void> {
    if (this.getSettings().pendingPairingCompletion?.pairingId === pairingId) {
      throw new Error("Pairing completion is already pending and cannot be canceled safely")
    }
    const remote = this.remote(endpoint)
    try {
      await remote.cancelPairing(pairingId, capability)
    } finally {
      this.secrets.clearPendingPairing(pairingId)
    }
  }

  private controller(): PairingController {
    const controller = this.getController()
    if (!controller) throw new Error("Meridian is not connected")
    return controller
  }

  private remote(endpoint: string): MeridianRemoteClient {
    return new MeridianRemoteClient(normalizeEndpoint(endpoint), new ObsidianHttpTransport())
  }

  private async submitJoin(
    remote: MeridianRemoteClient,
    pairingId: string,
    capability: string,
    payload: PairingJoin,
  ): Promise<void> {
    try {
      await remote.joinPairing(pairingId, payload)
    } catch (error) {
      try {
        const reconciled = await remote.getPairingProgress(pairingId, capability)
        if (reconciled.status !== "pending" && reconciled.status !== "canceled") return
        this.secrets.clearPendingPairing(pairingId)
      } catch {
        // Keep the exact candidate request so reopening the same link can reconcile and replay it.
      }
      throw error
    }
  }

  private pendingCompletionPayload(pairingId: string) {
    const serialized = this.secrets.getPendingPairingCompletion(pairingId)
    if (!serialized) throw new Error("Pending pairing completion is missing from SecretStorage")
    try {
      return Schema.decodeUnknownSync(PairingCandidateConfirmationSchema)(JSON.parse(serialized))
    } catch {
      // Fall through to the stable local-state error below.
    }
    throw new Error("Pending pairing completion in SecretStorage is invalid")
  }

  private pendingRelease(pairingId: string): {
    candidatePackage: string
    approvalPayload: PairingApproval
    releasePayload: PairingRelease
    transferHash: string
    verificationPhrase: string
  } {
    const serialized = this.secrets.getPendingPairingRelease(pairingId)
    if (!serialized) throw new Error("Locally withheld pairing transfer is missing")
    try {
      const value: unknown = JSON.parse(serialized)
      if (
        typeof value === "object" &&
        value !== null &&
        "candidatePackage" in value &&
        typeof value.candidatePackage === "string" &&
        "approvalPayload" in value &&
        "releasePayload" in value &&
        "transferHash" in value &&
        typeof value.transferHash === "string" &&
        "verificationPhrase" in value &&
        typeof value.verificationPhrase === "string"
      ) {
        return {
          candidatePackage: value.candidatePackage,
          approvalPayload: Schema.decodeUnknownSync(PairingApprovalSchema)(value.approvalPayload),
          releasePayload: Schema.decodeUnknownSync(PairingReleaseSchema)(value.releasePayload),
          transferHash: value.transferHash,
          verificationPhrase: value.verificationPhrase,
        }
      }
    } catch {
      // Fall through to the stable local-state error below.
    }
    throw new Error("Locally withheld pairing transfer is invalid")
  }

  private pairingExpiry(pendingSecret: string): number {
    try {
      const value: unknown = JSON.parse(pendingSecret)
      if (
        typeof value === "object" &&
        value !== null &&
        "expiresAt" in value &&
        typeof value.expiresAt === "number"
      ) {
        return value.expiresAt
      }
    } catch {
      // The crypto adapter will provide a more specific error when it parses the pending secret.
    }
    return Date.now()
  }
}
