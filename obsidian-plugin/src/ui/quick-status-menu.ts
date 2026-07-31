import { Menu, Notice } from "obsidian"
import { DevicesModal } from "./devices-pairing"
import { ConflictsModal, HistoryModal } from "./history-conflicts"
import type { MeridianUiHost } from "./host"
import {
  presentQuickStatus,
  type QuickStatusAction,
  type QuickStatusActionId,
} from "./quick-status-presentation"

export function showQuickStatusMenu(
  host: MeridianUiHost,
  event: MouseEvent,
  openStatus: () => void,
): void {
  createQuickStatusMenu(host, openStatus, Menu.forEvent(event)).showAtMouseEvent(event)
}

export function showQuickStatusMenuAtElement(
  host: MeridianUiHost,
  anchor: HTMLElement,
  openStatus: () => void,
): void {
  const bounds = anchor.getBoundingClientRect()
  createQuickStatusMenu(host, openStatus, new Menu()).showAtPosition(
    { x: bounds.left, y: bounds.top, width: bounds.width },
    anchor.ownerDocument,
  )
}

function createQuickStatusMenu(host: MeridianUiHost, openStatus: () => void, menu: Menu): Menu {
  const activeFile = host.app.workspace.getActiveFile()
  const presentation = presentQuickStatus(host.settings, host.getStatus(), activeFile !== null)
  menu.addItem((item) =>
    item.setTitle(presentation.title).setIcon(presentation.icon).setIsLabel(true),
  )
  if (presentation.detail) {
    menu.addItem((item) => item.setTitle(presentation.detail).setIsLabel(true))
  }

  let previousSection: QuickStatusAction["section"] | null = null
  for (const action of presentation.actions) {
    if (previousSection !== null && action.section !== previousSection) menu.addSeparator()
    previousSection = action.section
    menu.addItem((item) =>
      item
        .setTitle(action.title)
        .setIcon(action.icon)
        .setDisabled(action.disabled)
        .onClick(() => runAction(host, action.id, activeFile?.path ?? null, openStatus)),
    )
  }
  return menu
}

function runAction(
  host: MeridianUiHost,
  action: QuickStatusActionId,
  activePath: string | null,
  openStatus: () => void,
): void {
  switch (action) {
    case "sync":
      void runSafely(() => host.syncNow())
      return
    case "pause":
      void runSafely(() => host.disconnect())
      return
    case "resume":
      void runSafely(() => host.resumeConnection())
      return
    case "history":
      if (activePath) new HistoryModal(host, activePath).open()
      return
    case "conflicts":
      new ConflictsModal(host).open()
      return
    case "devices":
      new DevicesModal(host).open()
      return
    case "status":
      openStatus()
      return
    case "settings":
      host.openSettings()
  }
}

async function runSafely(action: () => Promise<void>): Promise<void> {
  try {
    await action()
  } catch (error) {
    new Notice(error instanceof Error ? error.message : "Unable to change Meridian sync state")
  }
}
