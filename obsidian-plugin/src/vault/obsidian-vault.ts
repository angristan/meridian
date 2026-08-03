import { normalizePath, TFile, type Vault } from "obsidian"
import type { ConfigCategory, ScannedFileSnapshot, VaultPort, VaultScanOptions } from "../model"
import { BackgroundSyncCompute, type SyncComputePort } from "../platform/background-sync"
import { yieldToEventLoop } from "../platform/scheduling"
import {
  configCategoryForPath,
  isConfigPath,
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
    private readonly compute: SyncComputePort = new BackgroundSyncCompute(),
  ) {
    this.configDir = normalizeVaultPath(vault.configDir)
  }

  maxFileBytes(): number {
    return this.fileSizeLimit()
  }

  close(): void {
    this.compute.close()
  }

  async listFiles(
    categories: Record<ConfigCategory, boolean>,
    options: VaultScanOptions = {},
  ): Promise<ScannedFileSnapshot[]> {
    const paths = new Set<string>()
    const cachedStats = new Map<string, { size: number; mtime: number }>()
    let discovered = 0
    for (const file of this.vault.getFiles()) {
      if (options.shouldStop?.()) throw new Error("Vault scan canceled")
      if (isSyncablePath(file.path, this.configDir, categories)) {
        const path = normalizeVaultPath(file.path)
        paths.add(path)
        cachedStats.set(path, file.stat)
      }
      discovered += 1
      if (discovered % 500 === 0) await yieldToEventLoop()
    }
    for (const path of await this.listSelectedConfigFiles(categories, options)) paths.add(path)

    return this.scanFilesWithStats([...paths], categories, options, cachedStats)
  }

  async scanFiles(
    paths: readonly string[],
    categories: Record<ConfigCategory, boolean>,
    options: VaultScanOptions = {},
  ): Promise<ScannedFileSnapshot[]> {
    return this.scanFilesWithStats(paths, categories, options, new Map())
  }

  private async scanFilesWithStats(
    paths: readonly string[],
    categories: Record<ConfigCategory, boolean>,
    options: VaultScanOptions,
    cachedStats: ReadonlyMap<string, { size: number; mtime: number }>,
  ): Promise<ScannedFileSnapshot[]> {
    const snapshots: ScannedFileSnapshot[] = []
    const candidates = [...new Set(paths.map(normalizeVaultPath))].sort()
    let index = 0
    const reportProgress = (path: string) => {
      index += 1
      options.onProgress?.({
        kind: "scan",
        processed: index,
        total: candidates.length,
        currentPath: path,
      })
    }
    for (const candidate of candidates) {
      if (options.shouldStop?.()) throw new Error("Vault scan canceled")
      if (!isSyncablePath(candidate, this.configDir, categories)) {
        reportProgress(candidate)
        continue
      }
      const cachedStat = cachedStats.get(candidate)
      const adapterStat = cachedStat
        ? null
        : await this.vault.adapter.stat(normalizePath(candidate))
      if (!cachedStat && adapterStat?.type !== "file") {
        reportProgress(candidate)
        continue
      }
      const stat = cachedStat ?? adapterStat
      if (!stat) throw new Error("Vault file metadata disappeared during scanning")
      if (stat.size > this.maxFileBytes()) {
        throw new Error(`${candidate} exceeds the configured mobile-safe file size limit`)
      }
      const kind = isConfigPath(candidate, this.configDir) ? "config" : "vault"
      const cachedFingerprint = options.forceFingerprint
        ? undefined
        : options.fingerprintCache?.get(candidate)
      const fileFingerprint =
        cachedFingerprint &&
        cachedFingerprint.size === stat.size &&
        cachedFingerprint.mtime === stat.mtime &&
        cachedFingerprint.kind === kind
          ? cachedFingerprint.fingerprint
          : await this.compute.fingerprint(await this.read(candidate), options.shouldStop)
      if (options.shouldStop?.()) throw new Error("Vault scan canceled")
      snapshots.push({
        path: candidate,
        fingerprint: fileFingerprint,
        size: stat.size,
        mtime: stat.mtime,
        kind,
      })
      reportProgress(candidate)
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
    options: VaultScanOptions,
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

    let processed = 0
    for (const relative of candidates) {
      if (options.shouldStop?.()) throw new Error("Vault scan canceled")
      const path = normalizeVaultPath(`${root}/${relative}`)
      const category = configCategoryForPath(path, root)
      if (
        category &&
        categories[category] &&
        (await this.vault.adapter.exists(normalizePath(path)))
      ) {
        paths.push(path)
      }
      processed += 1
      if (processed % 25 === 0) await yieldToEventLoop()
    }
    if (categories.themes) {
      paths.push(...(await this.listAdapterFiles(`${root}/themes`, options)))
      paths.push(...(await this.listAdapterFiles(`${root}/snippets`, options)))
    }
    return paths.filter((path) => isSyncablePath(path, root, categories))
  }

  private async listAdapterFiles(root: string, options: VaultScanOptions): Promise<string[]> {
    const normalizedRoot = normalizePath(normalizeVaultPath(root))
    if (!(await this.vault.adapter.exists(normalizedRoot))) return []
    const pending = [normalizedRoot]
    const files: string[] = []
    let processed = 0
    while (pending.length > 0) {
      if (options.shouldStop?.()) throw new Error("Vault scan canceled")
      const directory = pending.pop()
      if (!directory) continue
      const listed = await this.vault.adapter.list(directory)
      files.push(...listed.files.map(normalizeVaultPath))
      pending.push(...listed.folders.map(normalizeVaultPath))
      processed += 1
      if (processed % 25 === 0) await yieldToEventLoop()
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
