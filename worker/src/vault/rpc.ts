import { HttpError } from "../errors"

export type VaultReply<T> = {
  body: T
  status: number
}

export type VaultRpcError = {
  status: number
  code: string
  message: string
}

export type VaultRpcResult<T> = { ok: true; value: T } | { ok: false; error: VaultRpcError }

export type VaultRpcCall<T> =
  | PromiseLike<VaultRpcResult<T>>
  | PromiseLike<{ ok: true; value: T }>
  | PromiseLike<{ ok: false; error: VaultRpcError }>

export function reply<T>(body: T, status = 200): VaultReply<T> {
  return { body, status }
}

export async function runRpc<T>(operation: () => T | Promise<T>): Promise<VaultRpcResult<T>> {
  try {
    return { ok: true, value: await operation() }
  } catch (error) {
    if (error instanceof HttpError) {
      return {
        ok: false,
        error: { status: error.status, code: error.code, message: error.message },
      }
    }

    console.error("Unhandled Meridian vault failure", {
      error: error instanceof Error ? error.name : "unknown",
    })
    return {
      ok: false,
      error: {
        status: 500,
        code: "internal_error",
        message: "The request could not be completed",
      },
    }
  }
}
