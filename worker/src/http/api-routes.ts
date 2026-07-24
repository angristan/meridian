import {
  AuthChallengeSchema,
  AuthSessionSchema,
  CheckpointSchema,
  CreatePairingSchema,
  OperationSchema,
  PairingApprovalSchema,
  PairingJoinSchema,
  PairingResultSchema,
  RecoveryClaimSchema,
  RevokeDeviceSchema,
  SnapshotSchema,
} from "../schemas"
import { runResponse } from "./effect-boundary"
import { proxyJson } from "./json-proxy"
import { requiredParam } from "./request"
import { sessionToken } from "./session"
import type { WorkerApp } from "./types"
import { callVaultEffect } from "./vault-proxy"

export function registerApiRoutes(app: WorkerApp): void {
  app.post(
    "/v1/auth/challenge",
    proxyJson(AuthChallengeSchema, () => "/v1/auth/challenge"),
  )
  app.post(
    "/v1/auth/session",
    proxyJson(AuthSessionSchema, () => "/v1/auth/session"),
  )
  app.get("/v1/recovery/package", (c) =>
    runResponse(callVaultEffect(c.env, "/v1/recovery/package", "GET")),
  )
  app.post("/v1/recovery/challenge", (c) =>
    runResponse(callVaultEffect(c.env, "/v1/recovery/challenge", "POST")),
  )
  app.post(
    "/v1/recovery/claim",
    proxyJson(RecoveryClaimSchema, () => "/v1/recovery/claim"),
  )
  app.get("/v1/devices", (c) =>
    runResponse(callVaultEffect(c.env, "/v1/devices", "GET", undefined, sessionToken(c))),
  )
  app.post(
    "/v1/devices/:id/revoke",
    proxyJson(
      RevokeDeviceSchema,
      (c) => `/v1/devices/${encodeURIComponent(requiredParam(c, "id"))}/revoke`,
      { authenticated: true },
    ),
  )
  app.post(
    "/v1/pairings",
    proxyJson(CreatePairingSchema, () => "/v1/pairings", { authenticated: true }),
  )
  app.post(
    "/v1/pairings/:id/join",
    proxyJson(
      PairingJoinSchema,
      (c) => `/v1/pairings/${encodeURIComponent(requiredParam(c, "id"))}/join`,
    ),
  )
  app.post(
    "/v1/pairings/:id/approve",
    proxyJson(
      PairingApprovalSchema,
      (c) => `/v1/pairings/${encodeURIComponent(requiredParam(c, "id"))}/approve`,
      { authenticated: true },
    ),
  )
  app.post(
    "/v1/pairings/:id/result",
    proxyJson(
      PairingResultSchema,
      (c) => `/v1/pairings/${encodeURIComponent(requiredParam(c, "id"))}/result`,
    ),
  )
  app.post(
    "/v1/operations",
    proxyJson(OperationSchema, () => "/v1/operations", { authenticated: true }),
  )
  app.put(
    "/v1/checkpoints",
    proxyJson(CheckpointSchema, () => "/v1/checkpoints", {
      authenticated: true,
      method: "PUT",
    }),
  )
  app.get("/v1/checkpoints/latest", (c) =>
    runResponse(
      callVaultEffect(c.env, "/v1/checkpoints/latest", "GET", undefined, sessionToken(c)),
    ),
  )
  app.put(
    "/v1/snapshot",
    proxyJson(SnapshotSchema, () => "/v1/snapshot", {
      authenticated: true,
      method: "PUT",
    }),
  )
  app.get("/v1/snapshot", (c) => {
    const id = c.req.query("id")
    const query = id === undefined ? "" : `?id=${encodeURIComponent(id)}`
    return runResponse(
      callVaultEffect(c.env, `/v1/snapshot${query}`, "GET", undefined, sessionToken(c)),
    )
  })
  app.get("/v1/changes", (c) => {
    const query = new URL(c.req.url).search
    return runResponse(
      callVaultEffect(c.env, `/v1/changes${query}`, "GET", undefined, sessionToken(c)),
    )
  })
}
