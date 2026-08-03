import { mkdir, rm, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"

const DEFAULT_SEED = 0x4d455249
const DEFAULT_STEPS = 4

export type FaultTraceValue = string | number | boolean | null

export interface FaultTraceEvent {
  index: number
  kind: string
  values: Record<string, FaultTraceValue>
}

export interface FaultTrace {
  version: 1
  seed: number
  configuredSteps: number
  events: FaultTraceEvent[]
  failure?: { message: string }
}

export class DeterministicRandom {
  private state: number

  constructor(readonly seed: number) {
    this.state = seed >>> 0 || 0x6d2b_79f5
  }

  nextUint32(): number {
    let value = this.state
    value ^= value << 13
    value ^= value >>> 17
    value ^= value << 5
    this.state = value >>> 0
    return this.state
  }

  shuffle<const Value>(values: readonly Value[]): Value[] {
    const shuffled = [...values]
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      const replacement = this.nextUint32() % (index + 1)
      const current = shuffled[index] as Value
      shuffled[index] = shuffled[replacement] as Value
      shuffled[replacement] = current
    }
    return shuffled
  }

  chance(numerator: number, denominator: number): boolean {
    if (!Number.isInteger(numerator) || !Number.isInteger(denominator)) {
      throw new Error("Fault probability must use integers")
    }
    if (denominator <= 0 || numerator < 0 || numerator > denominator) {
      throw new Error("Fault probability is invalid")
    }
    return this.nextUint32() % denominator < numerator
  }
}

export function campaignConfiguration(): { seeds: number[]; steps: number; timeout: number } {
  const baseSeed = environmentInteger("MERIDIAN_FAULT_SEED", DEFAULT_SEED, 0, 0xffff_ffff)
  const count = environmentInteger("MERIDIAN_FAULT_SEEDS", 1, 1, 10_000)
  const steps = environmentInteger("MERIDIAN_FAULT_STEPS", DEFAULT_STEPS, 1, 10_000)
  const seeds = Array.from(
    { length: count },
    (_, index) => (baseSeed + Math.imul(index, 0x9e37_79b9)) >>> 0,
  )
  return {
    seeds,
    steps,
    timeout: Math.max(30_000, count * steps * 250),
  }
}

export function createTrace(seed: number, configuredSteps: number): FaultTrace {
  return { version: 1, seed, configuredSteps, events: [] }
}

export function traceEvent(
  trace: FaultTrace,
  kind: string,
  values: Record<string, FaultTraceValue>,
): void {
  trace.events.push({ index: trace.events.length, kind, values })
}

export async function clearFailureTrace(seed: number, configuredSteps: number): Promise<void> {
  await rm(failureTracePath(seed, configuredSteps), { force: true })
}

export async function persistFailureTrace(trace: FaultTrace, error: unknown): Promise<string> {
  const failure = error instanceof Error ? error : new Error(String(error))
  trace.failure = { message: failure.message }
  const path = failureTracePath(trace.seed, trace.configuredSteps)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(trace, null, 2)}\n`, "utf8")
  return path
}

function failureTracePath(seed: number, configuredSteps: number): string {
  const directory =
    process.env.MERIDIAN_FAULT_TRACE_DIR ?? resolve(process.cwd(), "..", ".fault-traces")
  return resolve(directory, `plugin-seed-${seed}-steps-${configuredSteps}.json`)
}

function environmentInteger(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`)
  }
  return value
}
