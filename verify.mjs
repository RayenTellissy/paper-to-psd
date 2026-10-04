import { readPsd, initializeCanvas } from "ag-psd"
initializeCanvas(() => { throw new Error("no canvas") }, (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }))
import { readFileSync, writeFileSync } from "node:fs"
import { PNG } from "pngjs"
const psd = readPsd(readFileSync(process.argv[2]), { useImageData: true })
const W = psd.width, H = psd.height, out = new Float64Array(W * H * 4)
const leaves = (ls, o = 1) => ls.flatMap((l) => l.children ? leaves(l.children, o * (l.opacity ?? 1)) : [{ ...l, eff: o * (l.opacity ?? 1) }])
for (const l of leaves(psd.children)) {
  if (l.hidden) continue
  const d = l.imageData
  for (let y = 0; y < d.height; y++) for (let x = 0; x < d.width; x++) {
    const X = x + l.left, Y = y + l.top
    if (X < 0 || Y < 0 || X >= W || Y >= H) continue
    const s = (y * d.width + x) * 4, t = (Y * W + X) * 4, a = d.data[s + 3] / 255 * l.eff
    for (let c = 0; c < 3; c++) out[t + c] = d.data[s + c] * a + out[t + c] * (1 - a)
    out[t + 3] = 255 * a + out[t + 3] * (1 - a)
  }
}
let diff = 0, bad = 0
const vis = new PNG({ width: W, height: H })
for (let i = 0; i < W * H; i++) {
  let px = 0
  for (let c = 0; c < 3; c++) px += Math.abs(out[i * 4 + c] - psd.imageData.data[i * 4 + c])
  diff += px; if (px > 30) bad++
  vis.data[i * 4] = Math.min(255, px * 3); vis.data[i * 4 + 3] = 255
}
writeFileSync("diff.png", PNG.sync.write(vis))
const tree = (ls, d = 0) => ls.map((l) => "  ".repeat(d) + (l.children ? `[${l.name}]\n` + tree(l.children, d + 1) : `${l.name} @${l.left},${l.top} ${l.right - l.left}x${l.bottom - l.top}`)).join("\n")
console.log(tree(psd.children))
void (psd.children.map((l) => `${l.name} @${l.left},${l.top} ${l.right - l.left}x${l.bottom - l.top}`).join("\n"))
console.log("mean diff/px:", (diff / W / H / 3).toFixed(2), "bad px %:", (100 * bad / W / H).toFixed(2))
