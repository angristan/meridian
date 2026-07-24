import { HttpError } from "../errors"
import type { WorkerContext } from "./types"

export function requiredParam(c: WorkerContext, name: string): string {
  const value = c.req.param(name)
  if (value === undefined) throw new HttpError(400, "missing_parameter", `${name} is required`)
  return value
}
