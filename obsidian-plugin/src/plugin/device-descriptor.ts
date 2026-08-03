import { Platform } from "obsidian"

export function defaultDeviceName(): string {
  if (Platform.isIosApp) return "iPhone or iPad"
  if (Platform.isAndroidApp) return "Android device"
  if (Platform.isMacOS) return "Mac"
  if (Platform.isWin) return "Windows PC"
  if (Platform.isLinux) return "Linux computer"
  return "Desktop device"
}

export function defaultDevicePlatform(): string {
  if (Platform.isIosApp) return "iOS"
  if (Platform.isAndroidApp) return "Android"
  if (Platform.isMacOS) return "macOS"
  if (Platform.isWin) return "Windows"
  if (Platform.isLinux) return "Linux"
  return "Desktop"
}
