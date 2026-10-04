// Wraps blurred text in a Smart Object with a live Gaussian Blur, so the text stays editable and keeps its blur.
import { writePsdBuffer } from "ag-psd"
import { writeDataRLE } from "ag-psd/dist/helpers.js"
import { randomUUID } from "node:crypto"

// CSS blur(Npx) uses N as the standard deviation, which is what Photoshop's Gaussian Blur radius means too.
export const blurRadius = (filter = "") => {
  const match = /blur\(\s*([\d.]+)px\s*\)/.exec(filter)
  return match ? Number(match[1]) : 0
}

export const withoutBlur = (filter = "") => filter.replace(/blur\([^)]*\)/g, "").trim() || "none"

const gaussianBlur = (radius) => ({
  enabled: true,
  validAtPosition: true,
  maskEnabled: true,
  maskLinked: false,
  maskExtendWithWhite: true,
  list: [{
    name: "Gaussian Blur...",
    type: "gaussian blur",
    opacity: 1,
    blendMode: "normal",
    enabled: true,
    hasOptions: true,
    foregroundColor: { r: 0, g: 0, b: 0 },
    backgroundColor: { r: 255, g: 255, b: 255 },
    filter: { radius: { units: "Pixels", value: radius } },
  }],
})

// Smart filters keep a cache of the Smart Object's unfiltered pixels (R, G, B, alpha) plus a white filter mask.
// Like Photoshop, both cover the whole document and are RLE-compressed with 4-byte row lengths (even inside a
// regular PSD; 2-byte lengths make Photoshop fail to open the file). Every mask is identical, which also
// sidesteps ag-psd writing the last mask's extra block for all of them.
const rle = (rgba, width, height, offset) => ({
  compressionMode: 1,
  data: writeDataRLE(new Uint8Array(width * height * 2 + height * 4 + 1024), { data: rgba, width, height }, [offset], true),
})
const filterCache = ({ id, doc, left, top, width, height, rgba }) => {
  // Transparent areas are white, as in Photoshop's own caches.
  const canvas = new Uint8ClampedArray(doc.width * doc.height * 4)
  for (let i = 0; i < canvas.length; i += 4) canvas.set([255, 255, 255, 0], i)
  const x0 = Math.max(0, left), x1 = Math.min(doc.width, left + width)
  for (let y = Math.max(0, top); y < Math.min(doc.height, top + height); y++) {
    for (let x = x0; x < x1; x++) {
      const from = ((y - top) * width + (x - left)) * 4
      if (rgba[from + 3]) canvas.set(rgba.subarray(from, from + 4), (y * doc.width + x) * 4)
    }
  }
  const white = new Uint8ClampedArray(doc.width * doc.height * 4).fill(255)
  const bounds = { top: 0, left: 0, bottom: doc.height, right: doc.width }
  return {
    id,
    ...bounds,
    depth: 8,
    channels: [rle(canvas, doc.width, doc.height, 0), rle(canvas, doc.width, doc.height, 1), rle(canvas, doc.width, doc.height, 2), ...Array(22).fill(undefined), rle(canvas, doc.width, doc.height, 3)],
    extra: { ...bounds, ...rle(white, doc.width, doc.height, 0) },
  }
}

// Photoshop stores the filter mask overlay opacity as a percentage and always writes 50; ag-psd scales 0-1 to
// 0-255, so 0.5 would become 127, which Photoshop rejects with a program error when opening the file.
export const FILTER_MASK = { colorSpace: { r: 255, g: 0, b: 0 }, opacity: 50.5 / 255 }

const px = (value) => ({ units: "Pixels", value })

// sharp: unblurred render { left, top, imageData }; blurred: the render as seen in Paper.
// inner(dx, dy): extra props for the layer inside the Smart Object (text or shape data), shifted by the given offset.
// box: optional area (output px) the inner document must also cover, e.g. a shape partly clipped in the render.
// doc: the size of the PSD the layer goes into.
export const buildSmartLayer = ({ name, opacity, sharp, blurred, radius, inner = () => ({}), box, growRoom = 0, doc }) => {
  const spread = Math.ceil(radius * 3)
  const src = sharp.imageData
  const x0 = Math.min(sharp.left, box ? Math.floor(box.x) : Infinity)
  const y0 = Math.min(sharp.top, box ? Math.floor(box.y) : Infinity)
  const x1 = Math.max(sharp.left + src.width, box ? Math.ceil(box.x + box.width) : -Infinity)
  const y1 = Math.max(sharp.top + src.height, box ? Math.ceil(box.y + box.height) : -Infinity)
  // Room for the blur to spread, plus growRoom for content that may get longer when edited.
  const padX = spread + growRoom
  const left = x0 - padX
  const top = y0 - spread
  const width = x1 - x0 + padX * 2
  const height = y1 - y0 + spread * 2
  const innerLeft = sharp.left - left
  const innerTop = sharp.top - top

  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < src.height; y++) {
    data.set(src.data.subarray(y * src.width * 4, (y + 1) * src.width * 4), ((y + innerTop) * width + innerLeft) * 4)
  }

  const innerDoc = writePsdBuffer({
    width,
    height,
    imageData: { width, height, data },
    children: [{ name, left: innerLeft, top: innerTop, imageData: src, ...inner(-left, -top) }],
  }, { generateThumbnail: false, psb: true })

  const id = randomUUID()
  const placedId = randomUUID()
  const compInfo = { compID: -1, originalCompID: -1 }
  const linkedFile = {
    id,
    name: `${name}.psb`,
    type: "8BPB",
    creator: "8BIM",
    data: new Uint8Array(innerDoc),
    descriptor: { compInfo },
    childDocumentID: "",
    assetModTime: 0,
    assetLockedState: 0,
  }
  const layer = {
    name,
    opacity,
    ...blurred,
    placedLayer: {
      id,
      placed: placedId,
      type: "raster",
      pageNumber: 1,
      totalPages: 1,
      frameStep: { numerator: 0, denominator: 600 },
      duration: { numerator: 0, denominator: 600 },
      frameCount: 1,
      transform: [left, top, left + width, top, left + width, top + height, left, top + height],
      width,
      height,
      resolution: { units: "Density", value: 72 },
      warp: {
        style: "none",
        value: 0,
        perspective: 0,
        perspectiveOther: 0,
        rotate: "horizontal",
        bounds: { top: px(top), left: px(left), bottom: px(top + height), right: px(left + width) },
        uOrder: 4,
        vOrder: 4,
      },
      crop: 1,
      comp: -1,
      compInfo,
      filter: gaussianBlur(radius),
    },
  }
  return { layer, linkedFile, filterMask: filterCache({ id: placedId, doc, left, top, width, height, rgba: data }) }
}
