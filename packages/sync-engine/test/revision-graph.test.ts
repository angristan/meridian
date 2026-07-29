import { describe, expect, it } from "vitest"
import {
  ContentKind,
  type ContentKind as ContentKindType,
  MaterializationKind,
  materializeFile,
  materializeVault,
  type Revision,
  RevisionGraph,
} from "../src/index"

const encode = (value: string) => new TextEncoder().encode(value)
const decode = (value: Uint8Array) => new TextDecoder().decode(value)

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected test value")
  return value
}

function content(
  id: string,
  parents: readonly string[],
  path: string,
  value: string,
  kind: ContentKindType = ContentKind.Text,
): Revision {
  return {
    type: "content",
    id,
    fileId: "file-1",
    parents,
    path,
    contentKind: kind,
    content: encode(value),
    author: id,
  }
}

describe("RevisionGraph materialization", () => {
  it("converges when revisions arrive child-first", () => {
    const revisions = [
      content("a", [], "note.md", "title\nleft\nright"),
      content("b", ["a"], "renamed.md", "changed\nleft\nright"),
      content("c", ["a"], "note.md", "title\nleft\nchanged"),
    ]
    const forward = new RevisionGraph()
    const reverse = new RevisionGraph()
    for (const revision of revisions) forward.addRevision(revision)
    for (const revision of revisions.toReversed()) reverse.addRevision(revision)

    expect(forward.heads("file-1").map((revision) => revision.id)).toEqual(["b", "c"])
    expect(reverse.heads("file-1").map((revision) => revision.id)).toEqual(["b", "c"])
    const projection = materializeFile(reverse, "file-1")
    expect(projection[0]?.path).toBe("renamed.md")
    expect(decode(required(projection[0]).content)).toBe("changed\nleft\nchanged")
    expect(projection.map((entry) => entry.kind)).toEqual([
      MaterializationKind.Normal,
      MaterializationKind.RenameConflict,
    ])
  })

  it("removes every ancestor from multi-level head candidates", () => {
    const graph = new RevisionGraph()
    graph.addRevision(content("c", [], "note.md", "root"))
    graph.addRevision(content("b", ["c"], "note.md", "middle"))
    graph.addRevision(content("a", ["b"], "note.md", "head"))

    expect(graph.heads("file-1").map((revision) => revision.id)).toEqual(["a"])
  })

  it("materializes edit/delete as recovered content", () => {
    const graph = new RevisionGraph()
    graph.addRevision(content("a", [], "note.md", "base"))
    graph.addRevision(content("b", ["a"], "note.md", "valuable edit"))
    graph.addRevision({
      type: "tombstone",
      id: "c",
      fileId: "file-1",
      parents: ["a"],
      path: "note.md",
      author: "phone",
    })

    const projection = materializeFile(graph, "file-1")
    expect(projection).toHaveLength(1)
    expect(projection[0]?.kind).toBe(MaterializationKind.Recovered)
    expect(projection[0]?.path).toContain("meridian-recovered-b")
    expect(decode(required(projection[0]).content)).toBe("valuable edit")
  })

  it("keeps binary and config branches separate", () => {
    for (const kind of [ContentKind.Binary, ContentKind.Config]) {
      const graph = new RevisionGraph()
      graph.addRevision(content("a", [], "settings/data", "base", kind))
      graph.addRevision(content("b", ["a"], "settings/data", "left", kind))
      graph.addRevision(content("c", ["a"], "settings/data", "right", kind))
      const projection = materializeFile(graph, "file-1")
      expect(projection).toHaveLength(2)
      expect(new Set(projection.map((entry) => decode(entry.content)))).toEqual(
        new Set(["left", "right"]),
      )
      if (kind === ContentKind.Config) {
        expect(
          projection.every((entry) => entry.path.startsWith(".meridian/conflicts/config/")),
        ).toBe(true)
      }
    }
  })

  it("preserves cross-file Unicode and case-fold path collisions", () => {
    const graph = new RevisionGraph()
    graph.addRevision(content("a", [], "Café.md", "first"))
    graph.addRevision({
      ...content("b", [], "CAFE\u0301.md", "second"),
      fileId: "file-2",
    })

    const projection = materializeVault(graph, { caseSensitive: false })
    expect(projection).toHaveLength(2)
    expect(projection.some((item) => item.kind === MaterializationKind.PathConflict)).toBe(true)
    expect(new Set(projection.map((item) => decode(item.content)))).toEqual(
      new Set(["first", "second"]),
    )
  })

  it("rejects id reuse and cross-file ancestry", () => {
    const graph = new RevisionGraph()
    graph.addRevision(content("a", [], "note.md", "base"))
    expect(() => graph.addRevision(content("a", [], "note.md", "different"))).toThrow(/reused/)
    expect(() =>
      graph.addRevision({ ...content("b", ["a"], "other.md", "value"), fileId: "file-2" }),
    ).toThrow(/another file/)
  })
})
