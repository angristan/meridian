import { describe, expect, it } from "vitest"
import {
  ApplicationJournal,
  ContentKind,
  CursorInbox,
  type CursorOperation,
  LocalReplica,
  MaterializationKind,
  type MaterializedEntry,
  planApplication,
} from "../src/index"

const encode = (value: string) => new TextEncoder().encode(value)
const decode = (value: Uint8Array) => new TextDecoder().decode(value)

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected test value")
  return value
}

function operation(cursor: number, value = `${cursor}`): CursorOperation {
  return {
    cursor,
    operationId: `operation-${cursor}-${value}`,
    revision: {
      type: "content",
      id: `revision-${cursor}-${value}`,
      fileId: "file",
      parents: cursor === 1 ? [] : [`revision-${cursor - 1}-${cursor - 1}`],
      path: "note.md",
      contentKind: ContentKind.Text,
      content: encode(value),
      author: "device",
    },
  }
}

describe("CursorInbox", () => {
  it("buffers reorder, ignores duplicates, and requires explicit acknowledgement", () => {
    const inbox = new CursorInbox()
    const first = operation(1)
    const second = operation(2)
    inbox.receive(second)
    inbox.receive(second)
    expect(inbox.next()).toBeUndefined()
    inbox.receive(first)
    expect(inbox.next()?.cursor).toBe(1)
    inbox.acknowledge(first)
    expect(inbox.next()?.cursor).toBe(2)
    expect(new CursorInbox(inbox.snapshot()).next()?.operationId).toBe(second.operationId)
  })

  it("detects cursor equivocation", () => {
    const inbox = new CursorInbox()
    inbox.receive(operation(1, "left"))
    expect(() => inbox.receive(operation(1, "right"))).toThrow(/equivocation/)
  })
})

describe("application planning", () => {
  it("survives a crash after every effect and never advances the cursor early", () => {
    const replica = new LocalReplica({
      cursor: 0,
      files: new Map([
        ["old.md", encode("old")],
        ["unmanaged.md", encode("keep")],
      ]),
      managedPaths: new Set(["old.md"]),
    })
    const desired: MaterializedEntry[] = [
      {
        fileId: "file",
        path: "new.md",
        content: encode("new"),
        kind: MaterializationKind.Normal,
        sourceRevisionIds: ["revision-1-1"],
      },
    ]
    const nextOperation = operation(1)
    const plan = planApplication(replica.snapshot(), desired, nextOperation)
    let journal = new ApplicationJournal(plan)

    while (!journal.done) {
      const step = required(journal.next())
      replica.execute(step)
      // Model a crash before the journal write: replaying the filesystem effect is harmless.
      replica.execute(step)
      expect(replica.cursor).toBe(step.type === "checkpoint" ? 1 : 0)
      journal.complete(step.id)
      journal = new ApplicationJournal(plan, journal.snapshot().completedStepIds)
    }

    expect(decode(required(replica.files.get("new.md")))).toBe("new")
    expect(replica.files.has("old.md")).toBe(false)
    expect(decode(required(replica.files.get("unmanaged.md")))).toBe("keep")
    expect(replica.cursor).toBe(1)
  })
})
