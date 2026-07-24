const version = process.argv[2]

if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error("Usage: bun scripts/prepare-release.ts <x.y.z>")
}

const readJson = async <T>(path: string): Promise<T> => Bun.file(path).json() as Promise<T>
const writeJson = (path: string, value: unknown) =>
  Bun.write(path, `${JSON.stringify(value, null, 2)}\n`)

const manifest = await readJson<Record<string, unknown>>("manifest.json")
const minAppVersion = manifest.minAppVersion
if (typeof minAppVersion !== "string") {
  throw new Error("manifest.json must contain minAppVersion")
}
manifest.version = version

const versions = await readJson<Record<string, string>>("versions.json")
versions[version] = minAppVersion

const pluginPackage = await readJson<Record<string, unknown>>("obsidian-plugin/package.json")
pluginPackage.version = version

await Promise.all([
  writeJson("manifest.json", manifest),
  writeJson("versions.json", versions),
  writeJson("obsidian-plugin/package.json", pluginPackage),
])

console.log(`Prepared Meridian Sync ${version}`)
