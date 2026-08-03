import {
  AuthChallengeSchema,
  AuthSessionSchema,
  CheckpointSchema,
  CreatePairingSchema,
  DeviceDescriptorSchema,
  EmptyObjectSchema,
  OperationSchema,
  PairingApprovalSchema,
  PairingCancelSchema,
  PairingCandidateConfirmationSchema,
  PairingJoinSchema,
  PairingReleaseSchema,
  PairingResultSchema,
  RecoveryClaimSchema,
  RetentionAcknowledgementSchema,
  RevokeDeviceSchema,
  SnapshotSchema,
} from "@meridian/protocol"
import { runHttpEffect } from "./effect-boundary"
import { proxyAuthenticatedJson, proxyJson } from "./json-proxy"
import { requiredParam } from "./request"
import { extractSessionToken } from "./session"
import type { WorkerApp } from "./types"
import { vaultResponseEffect } from "./vault-proxy"

export function registerApiRoutes(app: WorkerApp): void {
  app.post(
    "/v1/auth/challenge",
    proxyJson(AuthChallengeSchema, (vault, input) => vault.createAuthChallenge(input)),
  )
  app.post(
    "/v1/auth/session",
    proxyJson(AuthSessionSchema, (vault, input) => vault.createAuthSession(input)),
  )
  app.get("/v1/recovery/package", (context) =>
    runHttpEffect(vaultResponseEffect(context.env, (vault) => vault.recoveryPackage())),
  )
  app.post("/v1/recovery/challenge", (context) =>
    runHttpEffect(vaultResponseEffect(context.env, (vault) => vault.createRecoveryChallenge())),
  )
  app.post(
    "/v1/recovery/claim",
    proxyJson(RecoveryClaimSchema, (vault, input) => vault.recover(input)),
  )
  app.get("/v1/devices", (context) => {
    const token = extractSessionToken(context.req.raw)
    return runHttpEffect(vaultResponseEffect(context.env, (vault) => vault.listDevices(token)))
  })
  app.put(
    "/v1/device/descriptor",
    proxyAuthenticatedJson(DeviceDescriptorSchema, (vault, input, token) =>
      vault.updateDeviceDescriptor(token, input),
    ),
  )
  app.post(
    "/v1/devices/:id/revoke",
    proxyAuthenticatedJson(RevokeDeviceSchema, (vault, input, token, context) =>
      vault.revokeDevice(token, requiredParam(context, "id"), input),
    ),
  )
  app.post(
    "/v1/pairings",
    proxyAuthenticatedJson(CreatePairingSchema, (vault, input, token) =>
      vault.createPairing(token, input),
    ),
  )
  app.get("/v1/pairings/:id", (context) => {
    const token = extractSessionToken(context.req.raw)
    return runHttpEffect(
      vaultResponseEffect(context.env, (vault) =>
        vault.pairingStatus(token, requiredParam(context, "id")),
      ),
    )
  })
  app.post(
    "/v1/pairings/:id/status",
    proxyJson(PairingResultSchema, (vault, input, context) =>
      vault.pairingProgress(requiredParam(context, "id"), input),
    ),
  )
  app.post(
    "/v1/pairings/:id/join",
    proxyJson(PairingJoinSchema, (vault, input, context) =>
      vault.joinPairing(requiredParam(context, "id"), input),
    ),
  )
  app.post(
    "/v1/pairings/:id/approve",
    proxyAuthenticatedJson(PairingApprovalSchema, (vault, input, token, context) =>
      vault.approvePairing(token, requiredParam(context, "id"), input),
    ),
  )
  app.post(
    "/v1/pairings/:id/release",
    proxyAuthenticatedJson(PairingReleaseSchema, (vault, input, token, context) =>
      vault.releasePairing(token, requiredParam(context, "id"), input),
    ),
  )
  app.post(
    "/v1/pairings/:id/result",
    proxyJson(PairingResultSchema, (vault, input, context) =>
      vault.pairingResult(requiredParam(context, "id"), input),
    ),
  )
  app.post(
    "/v1/pairings/:id/confirm-owner",
    proxyAuthenticatedJson(EmptyObjectSchema, (vault, _input, token, context) =>
      vault.confirmPairingOwner(token, requiredParam(context, "id")),
    ),
  )
  app.post(
    "/v1/pairings/:id/confirm-candidate",
    proxyJson(PairingCandidateConfirmationSchema, (vault, input, context) =>
      vault.confirmPairingCandidate(requiredParam(context, "id"), input),
    ),
  )
  app.post(
    "/v1/pairings/:id/complete",
    proxyJson(PairingCandidateConfirmationSchema, (vault, input, context) =>
      vault.completePairing(requiredParam(context, "id"), input),
    ),
  )
  app.post(
    "/v1/pairings/:id/cancel",
    proxyJson(PairingCancelSchema, (vault, input, context) =>
      vault.cancelPairing(requiredParam(context, "id"), input),
    ),
  )
  app.post(
    "/v1/pairings/:id/reject",
    proxyAuthenticatedJson(EmptyObjectSchema, (vault, _input, token, context) =>
      vault.rejectPairing(token, requiredParam(context, "id")),
    ),
  )
  app.post(
    "/v1/operations",
    proxyAuthenticatedJson(OperationSchema, (vault, input, token) =>
      vault.commitOperation(token, input),
    ),
  )
  app.put(
    "/v1/checkpoints",
    proxyAuthenticatedJson(CheckpointSchema, (vault, input, token) =>
      vault.putCheckpoint(token, input),
    ),
  )
  app.get("/v1/checkpoints/latest", (context) => {
    const token = extractSessionToken(context.req.raw)
    return runHttpEffect(vaultResponseEffect(context.env, (vault) => vault.latestCheckpoint(token)))
  })
  app.put(
    "/v1/retention/acknowledgement",
    proxyAuthenticatedJson(RetentionAcknowledgementSchema, (vault, input, token) =>
      vault.acknowledgeRetention(token, input),
    ),
  )
  app.put(
    "/v1/snapshot",
    proxyAuthenticatedJson(SnapshotSchema, (vault, input, token) =>
      vault.putSnapshot(token, input),
    ),
  )
  app.get("/v1/snapshot", (context) => {
    const token = extractSessionToken(context.req.raw)
    return runHttpEffect(
      vaultResponseEffect(context.env, (vault) =>
        vault.getSnapshot(token, context.req.query("id") ?? null),
      ),
    )
  })
  app.get("/v1/changes", (context) => {
    const token = extractSessionToken(context.req.raw)
    const after = Number(context.req.query("after") ?? "0")
    const limit = Number(context.req.query("limit") ?? "200")
    const afterHash = context.req.query("afterHash") ?? null
    return runHttpEffect(
      vaultResponseEffect(context.env, (vault) => vault.changes(token, after, limit, afterHash)),
    )
  })
}
