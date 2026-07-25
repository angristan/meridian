import QRCode from "qrcode"

export async function renderPairingQr(canvas: HTMLCanvasElement, link: string): Promise<void> {
  canvas.setAttribute("aria-label", "Scan this pairing code with the new device")
  await QRCode.toCanvas(canvas, link, {
    errorCorrectionLevel: "M",
    margin: 2,
    width: 240,
    color: {
      dark: "#000000ff",
      light: "#ffffffff",
    },
  })
}
