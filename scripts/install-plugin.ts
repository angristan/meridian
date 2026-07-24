import { cp, mkdir, stat } from "node:fs/promises"
import { basename, join, resolve } from "node:path"

const args = process.argv.slice(2)
const vaultFlag = args.indexOf("--vault")
const vaultArgument = vaultFlag >= 0 ? args[vaultFlag + 1] : undefined

if (!vaultArgument) {
  throw new Error("Usage: bun run plugin:install -- --vault /path/to/disposable-vault")
}

const vault = resolve(vaultArgument)
const configDir = join(vault, ".obsidian")
const destination = join(configDir, "plugins", "meridian")

try {
  if (!(await stat(configDir)).isDirectory()) throw new Error("not a directory")
} catch {
  throw new Error(`${basename(vault)} is not an Obsidian vault: ${configDir} does not exist`)
}

console.log("Building Meridian…")
const build = Bun.spawn(["bun", "run", "plugin:build"], {
  cwd: resolve(import.meta.dir, ".."),
  stderr: "inherit",
  stdout: "inherit",
})
if ((await build.exited) !== 0) throw new Error("Plugin build failed")

await mkdir(destination, { recursive: true })
for (const name of ["main.js", "manifest.json", "styles.css"]) {
  await cp(resolve(import.meta.dir, "..", "obsidian-plugin", "dist", name), join(destination, name))
}

console.log(`Installed Meridian in ${destination}`)
console.log("Open Obsidian, enable Community plugins, then enable Meridian.")
