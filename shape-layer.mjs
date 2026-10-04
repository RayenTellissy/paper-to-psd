// Turns a plain Paper box (solid fill, rounded corners, optional solid border) into an editable Photoshop shape layer.

const KAPPA = 0.5523

const px = (value) => {
  const n = parseFloat(value)
  return Number.isFinite(n) ? n : 0
}

const parseColor = (value) => {
  if (!value || value === "transparent") return null
  const hex = value.trim().match(/^#([0-9a-f]{3,8})$/i)?.[1]
  if (hex) {
    const full = hex.length <= 4 ? [...hex].map((c) => c + c).join("") : hex
    const alpha = full.length === 8 ? parseInt(full.slice(6, 8), 16) / 255 : 1
    return { color: { r: parseInt(full.slice(0, 2), 16), g: parseInt(full.slice(2, 4), 16), b: parseInt(full.slice(4, 6), 16) }, alpha }
  }
  const rgb = value.match(/rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?/i)
  if (rgb) {
    const a = rgb[4] == null ? 1 : rgb[4].endsWith("%") ? parseFloat(rgb[4]) / 100 : +rgb[4]
    return { color: { r: Math.round(+rgb[1]), g: Math.round(+rgb[2]), b: Math.round(+rgb[3]) }, alpha: a }
  }
  return null
}

const radii = (style, width, height) => {
  const all = px(style.borderRadius)
  const corner = (key) => Math.min(style[key] != null ? px(style[key]) : all, width / 2, height / 2)
  return {
    topLeft: corner("borderTopLeftRadius"),
    topRight: corner("borderTopRightRadius"),
    bottomRight: corner("borderBottomRightRadius"),
    bottomLeft: corner("borderBottomLeftRadius"),
  }
}

// Clockwise rounded rectangle as Photoshop knots: [in-handle x, y, anchor x, y, out-handle x, y].
const roundedRectPath = (x, y, w, h, r) => {
  const k = (a, b, c) => ({ linked: true, points: [...a, ...b, ...c] })
  const knots = [
    k([x + r.topLeft * (1 - KAPPA), y], [x + r.topLeft, y], [x + r.topLeft, y]),
    k([x + w - r.topRight, y], [x + w - r.topRight, y], [x + w - r.topRight * (1 - KAPPA), y]),
    k([x + w, y + r.topRight * (1 - KAPPA)], [x + w, y + r.topRight], [x + w, y + r.topRight]),
    k([x + w, y + h - r.bottomRight], [x + w, y + h - r.bottomRight], [x + w, y + h - r.bottomRight * (1 - KAPPA)]),
    k([x + w - r.bottomRight * (1 - KAPPA), y + h], [x + w - r.bottomRight, y + h], [x + w - r.bottomRight, y + h]),
    k([x + r.bottomLeft, y + h], [x + r.bottomLeft, y + h], [x + r.bottomLeft * (1 - KAPPA), y + h]),
    k([x, y + h - r.bottomLeft * (1 - KAPPA)], [x, y + h - r.bottomLeft], [x, y + h - r.bottomLeft]),
    k([x, y + r.topLeft], [x, y + r.topLeft], [x, y + r.topLeft * (1 - KAPPA)]),
  ]
  // Square corners leave two knots on the same spot; merge them into one sharp corner.
  const merged = []
  for (const knot of knots) {
    const prev = merged.at(-1)
    if (prev && prev.points[2] === knot.points[2] && prev.points[3] === knot.points[3]) {
      prev.points = [...prev.points.slice(0, 4), ...knot.points.slice(4)]
      prev.linked = false
    } else {
      merged.push({ ...knot })
    }
  }
  const first = merged[0], last = merged.at(-1)
  if (merged.length > 1 && first.points[2] === last.points[2] && first.points[3] === last.points[3]) {
    first.points = [...last.points.slice(0, 2), ...first.points.slice(2)]
    first.linked = false
    merged.pop()
  }
  return { open: false, operation: "combine", fillRule: "non-zero", knots: merged }
}

const uv = (value) => ({ units: "Pixels", value })

// Splits on top-level commas only, so rgba(…) colours stay intact.
const splitTopLevel = (value) => {
  const parts = []
  let depth = 0, current = ""
  for (const ch of value) {
    if (ch === "(") depth++
    if (ch === ")") depth--
    if (ch === "," && depth === 0) {
      parts.push(current.trim())
      current = ""
    } else {
      current += ch
    }
  }
  if (current.trim()) parts.push(current.trim())
  return parts
}

export const hasBoxShadow = (style = {}) => !!style.boxShadow && style.boxShadow !== "none"

const parseShadows = (value) => splitTopLevel(value).map((part) => {
  const colorToken = part.match(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)/i)?.[0]
  const rest = colorToken ? part.replace(colorToken, " ") : part
  const [x = 0, y = 0, blur = 0, spread = 0] = (rest.match(/-?[\d.]+(?:px)?/g) ?? []).map(px)
  return { inset: /\binset\b/.test(part), color: parseColor(colorToken ?? "#000000"), x, y, blur, spread }
})

// CSS shadow -> Photoshop shadow: size covers blur + spread, spread becomes the choke percentage,
// and the angle points to where the light comes from.
const toPhotoshopShadow = ({ color, x, y, blur, spread }, scale) => {
  const size = Math.max(0, blur + Math.max(0, spread))
  // Same fields, in the same order, as the drop shadows Photoshop writes itself; it rejects shadows missing noise or contour.
  return {
    enabled: true,
    present: true,
    showInDialog: true,
    blendMode: "normal",
    color: color?.color ?? { r: 0, g: 0, b: 0 },
    opacity: color?.alpha ?? 1,
    useGlobalLight: false,
    angle: Math.round((Math.atan2(y, -x) * 180) / Math.PI),
    distance: uv(Math.hypot(x, y) * scale),
    choke: uv(size > 0 ? Math.round((Math.max(0, spread) / size) * 100) : 0),
    size: uv(size * scale),
    noise: 0,
    antialiased: false,
    contour: { name: "Linear", curve: [{ x: 0, y: 0 }, { x: 255, y: 255 }] },
    layerConceals: true,
  }
}

// Returns null when the box has anything a plain shape can't express (gradients, images, masks…).
// Shadows become layer effects when allowShadow is set; the layer's pixels must then be rendered without them.
export const shapeLayerProps = (style = {}, { allowShadow = false } = {}) => {
  const hasImage = style.backgroundImage && style.backgroundImage !== "none"
  if (hasImage || (hasBoxShadow(style) && !allowShadow) || style.maskImage || (style.transform && style.transform !== "none")) return null
  const shadows = hasBoxShadow(style) ? parseShadows(style.boxShadow) : []

  const fill = parseColor(style.backgroundColor)
  const borderWidth = px(style.borderWidth)
  const border = borderWidth > 0 && ["solid", "dashed"].includes(style.borderStyle) ? parseColor(style.borderColor) : null
  if (!fill && !border) return null

  // Photoshop's fill opacity also fades the stroke, so a see-through fill with a border is exported as two layers.
  const needsSplit = !!(fill && border && fill.alpha < 1)

  // box is in output pixels, relative to the document the layer is written into.
  // part: "all", or "fill" / "border" when the box is split.
  const build = (box, scale, part = "all") => {
    const r = radii(style, box.width / scale, box.height / scale)
    for (const key of Object.keys(r)) r[key] *= scale
    const path = roundedRectPath(box.x, box.y, box.width, box.height, r)
    const drop = shadows.filter((sh) => !sh.inset).map((sh) => toPhotoshopShadow(sh, scale))
    const inner = shadows.filter((sh) => sh.inset).map((sh) => toPhotoshopShadow(sh, scale))
    return {
      ...((drop.length || inner.length) && { effects: { ...(drop.length && { dropShadow: drop }), ...(inner.length && { innerShadow: inner }) } }),
      ...(part !== "border" && fill && fill.alpha < 1 && { fillOpacity: fill.alpha }),
      vectorFill: { type: "color", color: (fill ?? border).color },
      vectorMask: { paths: [path] },
      ...(border && part !== "fill" && {
        vectorStroke: {
          strokeEnabled: true,
          fillEnabled: !!fill && part === "all",
          lineWidth: uv(borderWidth * scale),
          lineDashOffset: uv(0),
          miterLimit: 100,
          lineCapType: "butt",
          lineJoinType: "miter",
          lineAlignment: "inside",
          scaleLock: false,
          strokeAdjust: false,
          lineDashSet: style.borderStyle === "dashed" ? [{ units: "None", value: 3 }, { units: "None", value: 3 }] : [],
          blendMode: "normal",
          opacity: border.alpha,
          content: { type: "color", color: border.color },
          resolution: 72,
        },
      }),
      vectorOrigination: {
        keyDescriptorList: [{
          keyOriginType: 2,
          keyOriginResolution: 72,
          keyOriginRRectRadii: { topRight: uv(r.topRight), topLeft: uv(r.topLeft), bottomLeft: uv(r.bottomLeft), bottomRight: uv(r.bottomRight) },
          keyOriginShapeBoundingBox: { top: uv(box.y), left: uv(box.x), bottom: uv(box.y + box.height), right: uv(box.x + box.width) },
          keyOriginBoxCorners: [
            { x: box.x, y: box.y },
            { x: box.x + box.width, y: box.y },
            { x: box.x + box.width, y: box.y + box.height },
            { x: box.x, y: box.y + box.height },
          ],
          transform: [1, 0, 0, 1, 0, 0],
        }],
      },
    }
  }
  build.needsSplit = needsSplit
  // Photoshop applies fill opacity on top of the layer's pixels, so a see-through fill must be rendered solid.
  const hex = (c) => "#" + [c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, "0")).join("")
  build.solidFill = fill && fill.alpha < 1 ? hex(fill.color) : null
  return build
}
