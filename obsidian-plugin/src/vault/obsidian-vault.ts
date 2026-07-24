import { normalizePath, TFile, type Vault } from "obsidian"
import type { ConfigCategory, ScannedFileSnapshot, VaultPort } from "../model"
import { fingerprint } from "../platform/bytes"
import {
  configCategoryForPath,
  isConfigPath,
  isSyncablePath,
  normalizeVaultPath,
} from "./path-policy"

export class ObsidianVaultPort implements VaultPort {
  readonly configDir: string

  constructor(
    private readonly vault: Vault,
    private readonly maxFileBytes: () => number,
  ) {
    this.configDir = normalizeVaultPath(vault.configDir)
  }

  async listFiles(categories: Record<ConfigCategory, boolean>): Promise<ScannedFileSnapshot[]> {
    const paths = new Set<string>()
    for (const file of this.vault.getFiles()) {
      if (isSyncablePath(file.path, this.configDir, categories))
        paths.add(normalizeVaultPath(file.path))
    }
    for (const path of await this.listSelectedConfigFiles(categories)) paths.add(path)

    const snapshots: ScannedFileSnapshot[] = []
    let index = 0
    for (const path of [...paths].sort()) {
      const stat = await this.vault.adapter.stat(normalizePath(path))
      if (stat?.type !== "file") continue
      if (stat.size > this.maxFileBytes()) {
        throw new Error(`${path} exceeds the configured mobile-safe file size limit`)
      }
      const bytes = await this.read(path)
      snapshots.push({
        path,
        fingerprint: await fingerprint(bytes),
        size: stat.size,
        mtime: stat.mtime,
        kind: isConfigPath(path, this.configDir) ? "config" : "vault",
      })
      index += 1
      if (index % 25 === 0) await yieldToUi()
    }
    return snapshots
  }

  async read(path: string): Promise<ArrayBuffer> {
    const normalized = normalizePath(normalizeVaultPath(path))
    if (isConfigPath(normalized, this.configDir)) {
      return this.vault.adapter.readBinary(normalized)
    }
    const file = this.vault.getFileByPath(normalized)
    if (!file) throw new Error(`File no longer exists: ${normalized}`)
    return this.vault.readBinary(file)
  }

  async write(path: string, bytes: ArrayBuffer): Promise<void> {
    const normalized = normalizePath(normalizeVaultPath(path))
    await this.ensureParent(normalized, isConfigPath(normalized, this.configDir))
    if (isConfigPath(normalized, this.configDir)) {
      await this.vault.adapter.writeBinary(normalized, bytes)
      return
    }

    const existing = this.vault.getAbstractFileByPath(normalized)
    if (existing instanceof TFile) {
      await this.vault.modifyBinary(existing, bytes)
      return
    }
    if (existing) throw new Error(`Cannot replace folder with file: ${normalized}`)
    await this.vault.createBinary(normalized, bytes)
  }

  async remove(path: string): Promise<void> {
    const normalized = normalizePath(normalizeVaultPath(path))
    if (isConfigPath(normalized, this.configDir)) {
      if (await this.vault.adapter.exists(normalized)) await this.vault.adapter.remove(normalized)
      return
    }
    const file = this.vault.getAbstractFileByPath(normalized)
    if (file) await this.vault.trash(file, true)
  }

  async exists(path: string): Promise<boolean> {
    const normalized = normalizePath(normalizeVaultPath(path))
    if (isConfigPath(normalized, this.configDir)) return this.vault.adapter.exists(normalized)
    return this.vault.getAbstractFileByPath(normalized) !== null
  }

  private async listSelectedConfigFiles(
    categories: Record<ConfigCategory, boolean>,
  ): Promise<string[]> {
    const paths: string[] = []
    const root = this.configDir
    const candidates = [
      "app.json",
      "appearance.json",
      "hotkeys.json",
      "core-plugins.json",
      "core-plugins-migration.json",
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
    ]

    for (const relative of candidates) {
      const path = normalizeVaultPath(`${root}/${relative}`)
      const category = configCategoryForPath(path, root)
      if (
        category &&
        categories[category] &&
        (await this.vault.adapter.exists(normalizePath(path)))
      ) {
        paths.push(path)
      }
    }
    if (categories.themes) {
      paths.push(...(await this.listAdapterFiles(`${root}/themes`)))
      paths.push(...(await this.listAdapterFiles(`${root}/snippets`)))
    }
    return paths.filter((path) => isSyncablePath(path, root, categories))
  }

  private async listAdapterFiles(root: string): Promise<string[]> {
    const normalizedRoot = normalizePath(normalizeVaultPath(root))
    if (!(await this.vault.adapter.exists(normalizedRoot))) return []
    const pending = [normalizedRoot]
    const files: string[] = []
    while (pending.length > 0) {
      const directory = pending.pop()
      if (!directory) continue
      const listed = await this.vault.adapter.list(directory)
      files.push(...listed.files.map(normalizeVaultPath))
      pending.push(...listed.folders.map(normalizeVaultPath))
    }
    return files
  }

  private async ensureParent(path: string, useAdapter: boolean): Promise<void> {
    const segments = path.split("/")
    segments.pop()
    let current = ""
    for (const segment of segments) {
      current = current.length === 0 ? segment : `${current}/${segment}`
      const normalized = normalizePath(current)
      if (useAdapter) {
        if (!(await this.vault.adapter.exists(normalized)))
          await this.vault.adapter.mkdir(normalized)
      } else if (!this.vault.getAbstractFileByPath(normalized)) {
        await this.vault.createFolder(normalized)
      }
    }
  }
}

function yieldToUi(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0))
}
