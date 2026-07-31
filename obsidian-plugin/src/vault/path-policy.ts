import type { ConfigCategory, SelectiveSyncSettings } from "../model"

export const CONFIG_ALLOWLIST_VERSION = 1

const CORE_PLUGIN_SETTING_FILES = new Set([
  "audio-recorder.json",
  "backlink.json",
  "bookmarks.json",
  "canvas.json",
  "command-palette.json",
  "daily-notes.json",
  "file-recovery.json",
  "graph.json",
  "note-composer.json",
  "outgoing-link.json",
  "page-preview.json",
  "properties.json",
  "publish.json",
  "random-note.json",
  "search.json",
  "slash-command.json",
  "slides.json",
  "switcher.json",
  "templates.json",
  "unique-note.json",
  "word-count.json",
  "zk-prefixer.json",
])

const ALWAYS_EXCLUDED_SEGMENTS = new Set([".git", ".meridian", ".trash"])
const SECRET_FILENAMES = new Set(["secrets.json", "secret-storage.json", "secretstorage.json"])

export function normalizeVaultPath(input: string): string {
  const normalized = input
    .replaceAll("\\", "/")
    .split("/")
    .filter((part) => part.length > 0 && part !== ".")
    .join("/")
    .normalize("NFC")

  if (normalized.includes("\0") || normalized.split("/").includes("..")) {
    throw new Error("Unsafe vault path")
  }
  return normalized
}

export function configCategoryForPath(path: string, configDir: string): ConfigCategory | null {
  const normalized = normalizeVaultPath(path)
  const root = normalizeVaultPath(configDir)
  if (normalized === root || !normalized.startsWith(`${root}/`)) return null

  const relative = normalized.slice(root.length + 1)
  if (relative === "app.json") return "main"
  if (relative === "appearance.json") return "appearance"
  if (relative === "hotkeys.json") return "hotkeys"
  if (relative === "core-plugins.json" || relative === "core-plugins-migration.json") {
    return "core-plugins"
  }
  if (relative.startsWith("themes/") || relative.startsWith("snippets/")) return "themes"
  if (CORE_PLUGIN_SETTING_FILES.has(relative)) return "core-plugin-settings"
  return null
}

export function isSyncablePath(
  path: string,
  configDir: string,
  selected: Record<ConfigCategory, boolean>,
): boolean {
  let normalized: string
  try {
    normalized = normalizeVaultPath(path)
  } catch {
    return false
  }
  if (normalized.length === 0) return false

  const segments = normalized.split("/")
  if (segments.some((segment) => ALWAYS_EXCLUDED_SEGMENTS.has(segment))) return false
  const filename = segments.at(-1)?.toLocaleLowerCase("en-US") ?? ""
  if (SECRET_FILENAMES.has(filename)) return false
  if (filename.endsWith(".tmp") || filename.endsWith(".part") || filename === ".ds_store") {
    return false
  }

  const root = normalizeVaultPath(configDir)
  if (normalized === root || normalized.startsWith(`${root}/`)) {
    const category = configCategoryForPath(normalized, root)
    return category !== null && selected[category]
  }
  // Hidden vault files and folders are commonly tool state, credentials, or caches. Only the
  // active Obsidian config directory is considered above, through its explicit allowlist.
  if (segments.some((segment) => segment.startsWith("."))) return false
  return true
}

export function isSelectedForSync(
  path: string,
  configDir: string,
  selection: SelectiveSyncSettings,
): boolean {
  const normalized = normalizeVaultPath(path)
  if (isConfigPath(normalized, configDir)) return true
  if (
    selection.excludedFolders.some(
      (folder) => normalized === folder || normalized.startsWith(`${folder}/`),
    )
  ) {
    return false
  }
  const filename = normalized.split("/").at(-1)?.toLocaleLowerCase("en-US") ?? ""
  return !selection.excludedExtensions.some((extension) => filename.endsWith(`.${extension}`))
}

export function normalizeExcludedFolder(value: string): string | null {
  let normalized: string
  try {
    normalized = normalizeVaultPath(value.trim())
  } catch {
    return null
  }
  if (normalized.length === 0) return null
  if (normalized.split("/").some((segment) => segment.startsWith("."))) return null
  return normalized
}

export function normalizeExcludedExtension(value: string): string | null {
  const normalized = value.trim().replace(/^\.+/, "").toLocaleLowerCase("en-US")
  if (!/^[a-z0-9][a-z0-9._+-]{0,31}$/.test(normalized)) return null
  return normalized
}

export function isConfigPath(path: string, configDir: string): boolean {
  const normalized = normalizeVaultPath(path)
  const root = normalizeVaultPath(configDir)
  return normalized === root || normalized.startsWith(`${root}/`)
}

export function pathsCollide(left: string, right: string): boolean {
  return (
    normalizeVaultPath(left).toLocaleLowerCase("en-US") ===
    normalizeVaultPath(right).toLocaleLowerCase("en-US")
  )
}

export function conflictPath(
  path: string,
  authorDeviceId: string,
  revisionId: string,
  configDir: string,
): string {
  const normalized = normalizeVaultPath(path)
  const suffix = `${safeSegment(authorDeviceId).slice(0, 12)}-${safeSegment(revisionId).slice(0, 12)}`
  if (isConfigPath(normalized, configDir)) {
    const relative = normalized.slice(normalizeVaultPath(configDir).length + 1)
    return normalizeVaultPath(`Meridian conflicts/config/${relative}.${suffix}`)
  }

  const slash = normalized.lastIndexOf("/")
  const directory = slash >= 0 ? normalized.slice(0, slash + 1) : ""
  const name = slash >= 0 ? normalized.slice(slash + 1) : normalized
  const dot = name.lastIndexOf(".")
  if (dot <= 0) return `${directory}${name}.conflict-${suffix}`
  return `${directory}${name.slice(0, dot)}.conflict-${suffix}${name.slice(dot)}`
}

function safeSegment(value: string): string {
  const safe = [...value.normalize("NFC")]
    .map((character) => (/^[A-Za-z0-9_-]$/.test(character) ? character : "-"))
    .join("")
  return safe.length > 0 ? safe : "unknown"
}
