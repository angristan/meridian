import { mkdir } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const traceDirectory = resolve(repository, ".fault-traces")
const UINT32_MAX = 0xffff_ffff

type Options = {
  seed: number
  seeds: number
  steps: number
  long: boolean
}

const options = parseOptions(process.argv.slice(2))
await mkdir(traceDirectory, { recursive: true })

console.log(
  `Fault campaign seed=${options.seed} seeds=${options.seeds} steps=${options.steps} mode=${options.long ? "long" : "short"}`,
)
console.log(`Replay: bun run fault:test --seed ${options.seed} --steps ${options.steps}`)

const environment = {
  ...process.env,
  MERIDIAN_FAULT_SEED: String(options.seed),
  MERIDIAN_FAULT_SEEDS: String(options.seeds),
  MERIDIAN_FAULT_STEPS: String(options.steps),
  MERIDIAN_FAULT_TRACE_DIR: traceDirectory,
}

await run(["bun", "run", "--cwd", "obsidian-plugin", "test", "--", "tests/fault-injection.test.ts"])
await run(["bun", "run", "--cwd", "worker", "test", "--", "test/fault-injection.test.ts"])

async function run(command: string[]): Promise<void> {
  const child = Bun.spawn(command, {
    cwd: repository,
    env: environment,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })
  const status = await child.exited
  if (status !== 0) process.exit(status)
}

function parseOptions(args: string[]): Options {
  let long = false
  let seed: number | undefined
  let seeds: number | undefined
  let steps: number | undefined

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] as string
    if (argument === "--long") {
      long = true
      continue
    }
    if (argument === "--help" || argument === "-h") {
      console.log(`Usage: bun run fault:test [options]

Options:
  --seed <n>   Replay one unsigned 32-bit seed
  --seeds <n>  Number of derived seeds in this process
  --steps <n>  Stateful sync steps per seed
  --long       Use the long campaign defaults
`)
      process.exit(0)
    }
    const parsed = optionValue(argument, args[index + 1])
    if (!parsed) throw new Error(`Unknown fault-test option: ${argument}`)
    if (!argument.includes("=")) index += 1
    if (parsed.name === "seed") seed = integerOption("seed", parsed.value, 0, UINT32_MAX)
    if (parsed.name === "seeds") seeds = integerOption("seeds", parsed.value, 1, 10_000)
    if (parsed.name === "steps") steps = integerOption("steps", parsed.value, 1, 10_000)
  }

  return {
    seed: seed ?? generatedSeed(),
    seeds: seeds ?? (long ? 50 : 1),
    steps: steps ?? (long ? 20 : 12),
    long,
  }
}

function optionValue(
  argument: string,
  following: string | undefined,
): { name: "seed" | "seeds" | "steps"; value: string } | null {
  for (const name of ["seed", "seeds", "steps"] as const) {
    const option = `--${name}`
    if (argument === option) {
      if (following === undefined) throw new Error(`${option} requires a value`)
      return { name, value: following }
    }
    if (argument.startsWith(`${option}=`)) return { name, value: argument.slice(option.length + 1) }
  }
  return null
}

function integerOption(name: string, raw: string, minimum: number, maximum: number): number {
  const value = Number(raw)
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`--${name} must be an integer from ${minimum} to ${maximum}`)
  }
  return value
}

function generatedSeed(): number {
  const value = new Uint32Array(1)
  crypto.getRandomValues(value)
  return value[0] ?? 0
}
