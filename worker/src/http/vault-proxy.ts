import * as Effect from "effect/Effect"
import { HttpError } from "../errors"
import type { VaultDurableObject } from "../vault-do"
import type { VaultReply, VaultRpcCall } from "../vault/rpc"
import type { WorkerEnv } from "./types"

const VAULT_OBJECT_NAME = "primary"

export type VaultStub = DurableObjectStub<VaultDurableObject>

function vaultStub(env: WorkerEnv): VaultStub {
  return env.VAULT.get(env.VAULT.idFromName(VAULT_OBJECT_NAME))
}

export function callVaultEffect<T>(
  env: WorkerEnv,
  call: (vault: VaultStub) => VaultRpcCall<VaultReply<T>>,
) {
  return Effect.tryPromise({
    try: async () => {
      const result = await call(vaultStub(env))
      if (!result.ok) {
        throw new HttpError(result.error.status, result.error.code, result.error.message)
      }
      return result.value
    },
    catch: (error) => {
      if (error instanceof HttpError) return error
      console.error("Vault RPC failed", {
        error: error instanceof Error ? error.name : "unknown",
      })
      return new HttpError(503, "vault_unavailable", "Vault coordinator is unavailable")
    },
  })
}

export function vaultResponseEffect<T>(
  env: WorkerEnv,
  call: (vault: VaultStub) => VaultRpcCall<VaultReply<T>>,
) {
  return callVaultEffect(env, call).pipe(Effect.map(vaultReplyResponse))
}

export function vaultReplyResponse(reply: VaultReply<unknown>): Response {
  const headers = { "cache-control": "no-store" }
  return reply.status === 204
    ? new Response(null, { status: 204, headers })
    : Response.json(reply.body, { status: reply.status, headers })
}

export function callVaultWebSocketEffect(env: WorkerEnv, sessionToken: string, source: Request) {
  return Effect.tryPromise({
    try: () => {
      const headers = new Headers({ authorization: `Bearer ${sessionToken}` })
      if (source.headers.get("upgrade")) headers.set("upgrade", "websocket")
      if (source.headers.get("connection")) headers.set("connection", "Upgrade")
      const requestedProtocols = source.headers.get("sec-websocket-protocol") ?? ""
      if (requestedProtocols.split(",").some((protocol) => protocol.trim() === "meridian.v1")) {
        headers.set("sec-websocket-protocol", "meridian.v1")
      }
      return vaultStub(env).fetch(
        new Request("https://vault.internal/v1/notifications", { method: "GET", headers }),
      )
    },
    catch: () => new HttpError(503, "vault_unavailable", "Vault coordinator is unavailable"),
  })
}
