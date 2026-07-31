import { normalizePath, TFile, type Vault } from "obsidian"
import type {
  ConfigCategory,
  ScannedFileSnapshot,
  SelectiveSyncSettings,
  VaultPort,
} from "../model"
import { fingerprint } from "../platform/bytes"
import { yieldToEventLoop } from "../platform/scheduling"
import {
  configCategoryForPath,
  isConfigPath,
  isSelectedForSync,
  isSyncablePath,
  normalizeVaultPath,
  pathsCollide,
} from "./path-policy"

function sameOptionalBytes(left: ArrayBuffer | null, right: ArrayBuffer | null): boolean {
  if (left === null || right === null) return left === right
  if (left.byteLength !== right.byteLength) return false
  const leftBytes = new Uint8Array(left)
  const rightBytes = new Uint8Array(right)
  return leftBytes.every((byte, index) => byte === rightBytes[index])
}

export class ObsidianVaultPort implements VaultPort {
  readonly configDir: string

  constructor(
    private readonly vault: Vault,
    private readonly fileSizeLimit: () => number,
  ) {
    this.configDir = normalizeVaultPath(vault.configDir)
  }

  maxFileBytes(): number {
    return this.fileSizeLimit()
  }

  async listFiles(
    categories: Record<ConfigCategory, boolean>,
    selection: SelectiveSyncSettings = { excludedFolders: [], excludedExtensions: [] },
  ): Promise<ScannedFileSnapshot[]> {
    const paths = new Set<string>()
    for (const file of this.vault.getFiles()) {
      if (
        isSyncablePath(file.path, this.configDir, categories) &&
        isSelectedForSync(file.path, this.configDir, selection)
      ) {
        paths.add(normalizeVaultPath(file.path))
      }
    }
    for (const path of await this.listSelectedConfigFiles(categories)) paths.add(path)

    return this.scanFiles([...paths], categories, selection)
  }

  async scanFiles(
    paths: readonly string[],
    categories: Record<ConfigCategory, boolean>,
    selection: SelectiveSyncSettings = { excludedFolders: [], excludedExtensions: [] },
  ): Promise<ScannedFileSnapshot[]> {
    const snapshots: ScannedFileSnapshot[] = []
    let index = 0
    for (const candidate of [...new Set(paths.map(normalizeVaultPath))].sort()) {
      if (
        !isSyncablePath(candidate, this.configDir, categories) ||
        !isSelectedForSync(candidate, this.configDir, selection)
      ) {
        continue
      }
      const stat = await this.vault.adapter.stat(normalizePath(candidate))
      if (stat?.type !== "file") continue
      if (stat.size > this.maxFileBytes()) {
        throw new Error(`${candidate} exceeds the configured mobile-safe file size limit`)
      }
      const bytes = await this.read(candidate)
      snapshots.push({
        path: candidate,
        fingerprint: await fingerprint(bytes),
        size: stat.size,
        mtime: stat.mtime,
        kind: isConfigPath(candidate, this.configDir) ? "config" : "vault",
      })
      index += 1
      if (index % 25 === 0) await yieldToEventLoop()
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
    this.assertSize(normalized, bytes)
    await this.ensureParent(normalized, isConfigPath(normalized, this.configDir))
    await this.writePrepared(normalized, bytes)
  }

  async replaceIfUnchanged(
    path: string,
    expectedBytes: ArrayBuffer | null,
    replacementBytes: ArrayBuffer | null,
    isText: boolean,
  ): Promise<boolean> {
    const normalized = normalizePath(normalizeVaultPath(path))
    if (replacementBytes) {
      this.assertSize(normalized, replacementBytes)
      await this.ensureParent(normalized, isConfigPath(normalized, this.configDir))
    }
    if (isText && expectedBytes !== null && replacementBytes !== null) {
      return this.replaceTextIfUnchanged(normalized, expectedBytes, replacementBytes)
    }
    const currentBytes = await this.readOptional(normalized)
    if (!sameOptionalBytes(currentBytes, expectedBytes)) return false

    if (replacementBytes) {
      await this.writePrepared(normalized, replacementBytes)
    } else if (currentBytes !== null && isConfigPath(normalized, this.configDir)) {
      await this.vault.adapter.remove(normalized)
    } else {
      await this.removePrepared(normalized)
    }
    return true
  }

  async rename(from: string, to: string): Promise<void> {
    const source = normalizePath(normalizeVaultPath(from))
    const target = normalizePath(normalizeVaultPath(to))
    if (source === target) return

    const configPath = isConfigPath(source, this.configDir)
    await this.ensureParent(target, configPath)
    if (configPath) {
      if (!(await this.vault.adapter.exists(source))) {
        if (await this.vault.adapter.exists(target)) return
        throw new Error(`File no longer exists: ${source}`)
      }
      await this.vault.adapter.rename(source, target)
      return
    }

    const file = this.vault.getFileByPath(source)
    if (!file) {
      if (this.vault.getFileByPath(target)) return
      throw new Error(`File no longer exists: ${source}`)
    }
    const existing = this.vault.getAbstractFileByPath(target)
    if (existing && existing !== file) throw new Error(`Rename target already exists: ${target}`)
    await this.vault.rename(file, target)
  }

  async renameIfUnchanged(from: string, to: string, expectedBytes: ArrayBuffer): Promise<boolean> {
    const source = normalizePath(normalizeVaultPath(from))
    const target = normalizePath(normalizeVaultPath(to))
    if (source === target) return sameOptionalBytes(await this.readOptional(source), expectedBytes)

    const configPath = isConfigPath(source, this.configDir)
    await this.ensureParent(target, configPath)
    if (!pathsCollide(source, target) && (await this.exists(target))) return false
    const currentBytes = await this.readOptional(source)
    if (!sameOptionalBytes(currentBytes, expectedBytes)) return false

    if (configPath) {
      await this.vault.adapter.rename(source, target)
      return true
    }
    const file = this.vault.getFileByPath(source)
    if (!file) return false
    const existing = this.vault.getAbstractFileByPath(target)
    if (existing && existing !== file) return false
    await this.vault.rename(file, target)
    return true
  }

  async remove(path: string): Promise<void> {
    await this.removePrepared(normalizePath(normalizeVaultPath(path)))
  }

  async exists(path: string): Promise<boolean> {
    const normalized = normalizePath(normalizeVaultPath(path))
    if (isConfigPath(normalized, this.configDir)) return this.vault.adapter.exists(normalized)
    return this.vault.getAbstractFileByPath(normalized) !== null
  }

  private assertSize(path: string, bytes: ArrayBuffer): void {
    if (bytes.byteLength > this.maxFileBytes()) {
      throw new Error(`${path} exceeds the configured mobile-safe file size limit`)
    }
  }

  private async readOptional(path: string): Promise<ArrayBuffer | null> {
    if (isConfigPath(path, this.configDir)) {
      const stat = await this.vault.adapter.stat(path)
      if (!stat) return null
      if (stat.type !== "file") throw new Error(`Cannot read folder as a file: ${path}`)
      return this.vault.adapter.readBinary(path)
    }
    const file = this.vault.getAbstractFileByPath(path)
    if (!file) return null
    if (!(file instanceof TFile)) throw new Error(`Cannot read folder as a file: ${path}`)
    return this.vault.readBinary(file)
  }

  private async replaceTextIfUnchanged(
    path: string,
    expectedBytes: ArrayBuffer,
    replacementBytes: ArrayBuffer,
  ): Promise<boolean> {
    const decoder = new TextDecoder("utf-8", { fatal: true })
    let expected: string
    let replacement: string
    try {
      expected = decoder.decode(expectedBytes)
      replacement = decoder.decode(replacementBytes)
    } catch {
      return false
    }
    let replaced = false
    const transform = (current: string): string => {
      if (current !== expected) return current
      replaced = true
      return replacement
    }
    if (isConfigPath(path, this.configDir)) {
      await this.vault.adapter.process(path, transform)
    } else {
      const file = this.vault.getFileByPath(path)
      if (!file) return false
      await this.vault.process(file, transform)
    }
    return replaced
  }

  private writePrepared(path: string, bytes: ArrayBuffer): Promise<void> {
    if (isConfigPath(path, this.configDir)) return this.vault.adapter.writeBinary(path, bytes)

    const existing = this.vault.getAbstractFileByPath(path)
    if (existing instanceof TFile) return this.vault.modifyBinary(existing, bytes)
    if (existing) throw new Error(`Cannot replace folder with file: ${path}`)
    return this.vault.createBinary(path, bytes).then(() => undefined)
  }

  private async removePrepared(path: string): Promise<void> {
    if (isConfigPath(path, this.configDir)) {
      const stat = await this.vault.adapter.stat(path)
      if (!stat) return
      if (stat.type !== "file") throw new Error(`Cannot remove folder as a file: ${path}`)
      await this.vault.adapter.remove(path)
      return
    }
    const file = this.vault.getAbstractFileByPath(path)
    if (!file) return
    if (!(file instanceof TFile)) throw new Error(`Cannot remove folder as a file: ${path}`)
    await this.vault.trash(file, true)
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
