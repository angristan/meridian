import { zipSync } from "fflate"

const pluginDirectory = `${import.meta.dir}/../obsidian-plugin`
const distributionDirectory = `${pluginDirectory}/dist`
const releaseFiles = ["main.js", "main.js.map", "manifest.json", "styles.css"] as const

const archiveEntries = Object.fromEntries(
  await Promise.all(
    releaseFiles.map(async (name) => {
      const file = Bun.file(`${distributionDirectory}/${name}`)
      if (!(await file.exists())) throw new Error(`Missing plugin release file: ${name}`)
      return [name, new Uint8Array(await file.arrayBuffer())] as const
    }),
  ),
)

await Bun.write(`${distributionDirectory}/meridian.zip`, zipSync(archiveEntries, { level: 9 }))
