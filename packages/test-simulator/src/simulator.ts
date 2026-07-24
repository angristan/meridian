import {
  ApplicationJournal,
  ContentKind,
  type ContentKind as ContentKindType,
  CursorInbox,
  type CursorOperation,
  LocalReplica,
  materializeFile,
  materializeVault,
  operationEqual,
  planApplication,
  type Revision,
  RevisionGraph,
  type RevisionOperation,
} from "@meridian/sync-engine"

interface ActiveApplication {
  readonly operation: CursorOperation
  readonly journal: ApplicationJournal
}

interface SimulatedDevice {
  readonly id: string
  readonly graph: RevisionGraph
  readonly inbox: CursorInbox
  readonly replica: LocalReplica
  readonly unpushed: Map<string, RevisionOperation>
  active: ActiveApplication | undefined
  sequence: number
}

export interface VisibleEntry {
  readonly path: string
  readonly kind: string
  readonly contentHex: string
  readonly sources: readonly string[]
}

const encoder = new TextEncoder()

function bytesToHex(value: Uint8Array): string {
  let output = ""
  for (const byte of value) output += byte.toString(16).padStart(2, "0")
  return output
}

function operationCopy(operation: CursorOperation): CursorOperation {
  return {
    cursor: operation.cursor,
    operationId: operation.operationId,
    revision:
      operation.revision.type === "tombstone"
        ? { ...operation.revision, parents: [...operation.revision.parents] }
        : {
            ...operation.revision,
            parents: [...operation.revision.parents],
            content: new Uint8Array(operation.revision.content),
          },
  }
}

export class InMemoryOperationServer {
  readonly #byId = new Map<string, CursorOperation>()
  readonly #log: CursorOperation[] = []

  push(operation: RevisionOperation): CursorOperation {
    const previous = this.#byId.get(operation.operationId)
    if (previous !== undefined) {
      if (!operationEqual(previous, operation)) throw new Error("Operation id reuse at server")
      return operationCopy(previous)
    }
    const committed: CursorOperation = { ...operation, cursor: this.#log.length + 1 }
    this.#log.push(operationCopy(committed))
    this.#byId.set(operation.operationId, operationCopy(committed))
    return operationCopy(committed)
  }

  changes(): readonly CursorOperation[] {
    return this.#log.map(operationCopy)
  }
}

export class SyncSimulator {
  readonly server = new InMemoryOperationServer()
  readonly #devices: SimulatedDevice[]
  readonly fileId = "simulated-file"

  constructor(deviceCount: number, initialText = "base\n") {
    if (!Number.isInteger(deviceCount) || deviceCount < 2) {
      throw new RangeError("Simulator requires at least two devices")
    }
    this.#devices = Array.from({ length: deviceCount }, (_, index) => ({
      id: `device-${index}`,
      graph: new RevisionGraph(),
      inbox: new CursorInbox(),
      replica: new LocalReplica(),
      unpushed: new Map(),
      active: undefined,
      sequence: 0,
    }))
    const initial: RevisionOperation = {
      operationId: "initial-operation",
      revision: {
        type: "content",
        id: "initial-revision",
        fileId: this.fileId,
        parents: [],
        path: "note.md",
        contentKind: ContentKind.Text,
        content: encoder.encode(initialText),
        author: "bootstrap",
      },
    }
    this.server.push(initial)
    for (let device = 0; device < deviceCount; device += 1) {
      this.deliver(device, 1)
      this.drain(device, true)
    }
  }

  get deviceCount(): number {
    return this.#devices.length
  }

  append(deviceIndex: number, token: string): string {
    const device = this.#device(deviceIndex)
    const visible = materializeFile(device.graph, this.fileId)[0]
    const previous = visible === undefined ? new Uint8Array() : visible.content
    const separator = previous.byteLength === 0 ? "" : "\n"
    const content = new Uint8Array(
      previous.byteLength + encoder.encode(`${separator}${token}`).byteLength,
    )
    content.set(previous)
    content.set(encoder.encode(`${separator}${token}`), previous.byteLength)
    return this.#contentChange(device, visible?.path ?? "note.md", content, ContentKind.Text)
  }

  replace(deviceIndex: number, token: string): string {
    const device = this.#device(deviceIndex)
    const visible = materializeFile(device.graph, this.fileId)[0]
    return this.#contentChange(
      device,
      visible?.path ?? "note.md",
      encoder.encode(token),
      ContentKind.Text,
    )
  }

  writeBinary(deviceIndex: number, bytes: Uint8Array): string {
    const device = this.#device(deviceIndex)
    const visible = materializeFile(device.graph, this.fileId)[0]
    return this.#contentChange(device, visible?.path ?? "attachment.bin", bytes, ContentKind.Binary)
  }

  rename(deviceIndex: number, path: string): string {
    const device = this.#device(deviceIndex)
    const visible = materializeFile(device.graph, this.fileId)[0]
    return this.#contentChange(
      device,
      path,
      visible?.content ?? encoder.encode("restored"),
      ContentKind.Text,
    )
  }

  delete(deviceIndex: number): string {
    const device = this.#device(deviceIndex)
    const heads = device.graph.heads(this.fileId)
    const revision = heads[0]
    return this.#record(device, {
      type: "tombstone",
      id: this.#nextId(device, "revision"),
      fileId: this.fileId,
      parents: heads.map((head) => head.id).sort(),
      path: revision?.path ?? "note.md",
      author: device.id,
    })
  }

  push(deviceIndex: number): readonly CursorOperation[] {
    const device = this.#device(deviceIndex)
    const committed: CursorOperation[] = []
    for (const operation of device.unpushed.values()) {
      committed.push(this.server.push(operation))
      device.unpushed.delete(operation.operationId)
    }
    return committed
  }

  pushAll(order: readonly number[] = this.#devices.map((_, index) => index)): void {
    for (const device of order) this.push(device)
  }

  deliver(deviceIndex: number, cursor: number): void {
    const operation = this.server.changes()[cursor - 1]
    if (operation === undefined) throw new RangeError(`Unknown server cursor ${cursor}`)
    this.#device(deviceIndex).inbox.receive(operation)
  }

  /** Applies all contiguous cursor entries. `crashy` repeats every effect before persisting it. */
  drain(deviceIndex: number, crashy = false): void {
    const device = this.#device(deviceIndex)
    while (true) {
      if (device.active === undefined) {
        const operation = device.inbox.next()
        if (operation === undefined) return
        device.graph.addOperation(operation)
        const desired = materializeVault(device.graph)
        device.active = {
          operation,
          journal: new ApplicationJournal(
            planApplication(device.replica.snapshot(), desired, operation),
          ),
        }
      }
      const active = device.active
      const step = active.journal.next()
      if (step === undefined) {
        device.inbox.acknowledge(active.operation)
        device.active = undefined
        continue
      }
      device.replica.execute(step)
      if (crashy) device.replica.execute(step)
      active.journal.complete(step.id)
    }
  }

  synchronizeAll(deliveryOrder?: readonly number[]): void {
    this.pushAll()
    const cursors = deliveryOrder ?? this.server.changes().map((operation) => operation.cursor)
    for (let device = 0; device < this.deviceCount; device += 1) {
      for (const cursor of cursors) {
        this.deliver(device, cursor)
        this.deliver(device, cursor)
      }
      this.drain(device, true)
    }
  }

  visible(deviceIndex: number): readonly VisibleEntry[] {
    return materializeVault(this.#device(deviceIndex).graph).map((entry) => ({
      path: entry.path,
      kind: entry.kind,
      contentHex: bytesToHex(entry.content),
      sources: [...entry.sourceRevisionIds],
    }))
  }

  headIds(deviceIndex: number): readonly string[] {
    return this.#device(deviceIndex)
      .graph.heads(this.fileId)
      .map((revision) => revision.id)
  }

  assertNoSilentLoss(deviceIndex: number): void {
    const device = this.#device(deviceIndex)
    const visibleSources = new Set(
      materializeVault(device.graph).flatMap((entry) => entry.sourceRevisionIds),
    )
    for (const head of device.graph.heads(this.fileId)) {
      if (head.type === "content" && !visibleSources.has(head.id)) {
        throw new Error(`Head ${head.id} has no materialized representation`)
      }
    }
  }

  #contentChange(
    device: SimulatedDevice,
    path: string,
    content: Uint8Array,
    contentKind: ContentKindType,
  ): string {
    return this.#record(device, {
      type: "content",
      id: this.#nextId(device, "revision"),
      fileId: this.fileId,
      parents: device.graph
        .heads(this.fileId)
        .map((head) => head.id)
        .sort(),
      path,
      contentKind,
      content: new Uint8Array(content),
      author: device.id,
    })
  }

  #record(device: SimulatedDevice, revision: Revision): string {
    const operation: RevisionOperation = {
      operationId: this.#nextId(device, "operation"),
      revision,
    }
    device.graph.addOperation(operation)
    device.unpushed.set(operation.operationId, operation)
    return revision.id
  }

  #nextId(device: SimulatedDevice, kind: string): string {
    device.sequence += 1
    return `${kind}-${device.id}-${device.sequence.toString().padStart(6, "0")}`
  }

  #device(index: number): SimulatedDevice {
    const device = this.#devices[index]
    if (device === undefined) throw new RangeError(`Unknown device ${index}`)
    return device
  }
}
