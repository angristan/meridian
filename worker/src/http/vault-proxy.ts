import { Effect } from "effect"
import { HttpError } from "../errors"
import type { VaultDurableObject } from "../vault-do"
import type { WorkerEnv } from "./types"

const VAULT_OBJECT_NAME = "primary"

function vaultStub(env: WorkerEnv): DurableObjectStub<VaultDurableObject> {
  return env.VAULT.get(env.VAULT.idFromName(VAULT_OBJECT_NAME))
}

export function callVaultEffect(
  env: WorkerEnv,
  path: string,
  method: string,
  body?: unknown,
  sessionToken?: string,
  source?: Request,
) {
  return Effect.tryPromise({
    try: () => {
      const headers = new Headers()
      if (body !== undefined) headers.set("content-type", "application/json")
      if (sessionToken) headers.set("authorization", `Bearer ${sessionToken}`)
      if (source?.headers.get("upgrade")) headers.set("upgrade", "websocket")
      if (source?.headers.get("connection")) headers.set("connection", "Upgrade")
      const requestedProtocols = source?.headers.get("sec-websocket-protocol") ?? ""
      if (requestedProtocols.split(",").some((protocol) => protocol.trim() === "meridian.v1")) {
        headers.set("sec-websocket-protocol", "meridian.v1")
      }
      const init: RequestInit = { method, headers }
      if (body !== undefined) init.body = JSON.stringify(body)
      const request = new Request(`https://vault.internal${path}`, init)
      return vaultStub(env).fetch(request)
    },
    catch: () => new HttpError(503, "vault_unavailable", "Vault coordinator is unavailable"),
  })
}
