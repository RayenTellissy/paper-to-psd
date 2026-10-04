// Draws the app icon (a stack of layers on a blue tile) and packs it as a Windows .ico.
import { PNG } from "pngjs"

const SAMPLES = 4

const insideTile = (x, y) => {
  const r = 0.22, m = 0.04
  const cx = Math.min(Math.max(x, m + r), 1 - m - r)
  const cy = Math.min(Math.max(y, m + r), 1 - m - r)
  return x >= m && x <= 1 - m && y >= m && y <= 1 - m && Math.hypot(x - cx, y - cy) <= r
}

const insideDiamond = (x, y, cy) => Math.abs(x - 0.5) / 0.3 + Math.abs(y - cy) / 0.15 <= 1

// Bottom to top: [centre y, white opacity].
const LAYERS = [[0.63, 0.45], [0.5, 0.7], [0.37, 1]]

const shade = (x, y) => {
  if (!insideTile(x, y)) return null
  let [r, g, b] = [45 + (27 - 45) * y, 107 + (63 - 107) * y, 255 + (204 - 255) * y]
  for (const [cy, alpha] of LAYERS) {
    if (!insideDiamond(x, y, cy)) continue
    r += (255 - r) * alpha
    g += (255 - g) * alpha
    b += (255 - b) * alpha
  }
  return [r, g, b]
}

const drawPng = (size) => {
  const png = new PNG({ width: size, height: size })
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, hits = 0
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const c = shade((px + (sx + 0.5) / SAMPLES) / size, (py + (sy + 0.5) / SAMPLES) / size)
          if (!c) continue
          r += c[0]
          g += c[1]
          b += c[2]
          hits++
        }
      }
      const i = (py * size + px) * 4
      png.data[i] = hits ? r / hits : 0
      png.data[i + 1] = hits ? g / hits : 0
      png.data[i + 2] = hits ? b / hits : 0
      png.data[i + 3] = (hits / SAMPLES ** 2) * 255
    }
  }
  return PNG.sync.write(png)
}

// ICO with PNG-compressed entries (supported since Windows Vista).
export const buildIco = (sizes = [16, 24, 32, 48, 64, 128, 256]) => {
  const images = sizes.map((size) => ({ size, data: drawPng(size) }))
  const header = Buffer.alloc(6 + images.length * 16)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)
  let offset = header.length
  images.forEach(({ size, data }, i) => {
    const at = 6 + i * 16
    header.writeUInt8(size >= 256 ? 0 : size, at)
    header.writeUInt8(size >= 256 ? 0 : size, at + 1)
    header.writeUInt16LE(1, at + 4)
    header.writeUInt16LE(32, at + 6)
    header.writeUInt32LE(data.length, at + 8)
    header.writeUInt32LE(offset, at + 12)
    offset += data.length
  })
  return Buffer.concat([header, ...images.map((image) => image.data)])
}

export const iconPng = drawPng
