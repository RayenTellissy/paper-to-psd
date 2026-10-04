// Builds Photoshop text-layer data from a Paper text node's computed CSS, so the text stays editable.

const INHERITED = ["fontFamily", "fontSize", "fontWeight", "fontStyle", "color", "lineHeight", "letterSpacing", "textAlign", "textTransform"]

const WEIGHT_NAMES = {
  100: "Thin",
  200: "ExtraLight",
  300: "Light",
  400: "Regular",
  500: "Medium",
  600: "SemiBold",
  700: "Bold",
  800: "ExtraBold",
  900: "Black",
}

// CSS values a text node doesn't set come from its ancestors, nearest first.
export const resolveTextStyle = (chain) => {
  const style = {}
  for (const key of INHERITED) {
    const owner = chain.find((s) => s?.[key] != null && s[key] !== "")
    if (owner) style[key] = owner[key]
  }
  return style
}

const px = (value, fallback) => {
  const n = parseFloat(value)
  return Number.isFinite(n) ? n : fallback
}

const parseColor = (value = "#000000") => {
  const hex = value.trim().match(/^#([0-9a-f]{3,8})$/i)?.[1]
  if (hex) {
    const full = hex.length <= 4 ? [...hex].map((c) => c + c).join("") : hex
    return { r: parseInt(full.slice(0, 2), 16), g: parseInt(full.slice(2, 4), 16), b: parseInt(full.slice(4, 6), 16) }
  }
  const rgb = value.match(/rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i)
  if (rgb) return { r: Math.round(+rgb[1]), g: Math.round(+rgb[2]), b: Math.round(+rgb[3]) }
  return { r: 0, g: 0, b: 0 }
}

// Google-style PostScript naming, e.g. "Plus Jakarta Sans" 600 italic -> "PlusJakartaSans-SemiBoldItalic".
const postScriptName = (family, weight, italic) => {
  const base = family.replace(/\s+/g, "")
  const rounded = Math.min(900, Math.max(100, Math.round(weight / 100) * 100))
  const weightName = WEIGHT_NAMES[rounded]
  const styleName = italic ? (weightName === "Regular" ? "Italic" : `${weightName}Italic`) : weightName
  return `${base}-${styleName}`
}

const firstFamily = (fontFamily = "Arial") => fontFamily.split(",")[0].trim().replace(/^["']|["']$/g, "")

const applyTransform = (text, transform) => {
  if (transform === "uppercase") return text.toUpperCase()
  if (transform === "lowercase") return text.toLowerCase()
  if (transform === "capitalize") return text.replace(/\b\p{L}/gu, (c) => c.toUpperCase())
  return text
}

// box: the node's position and size relative to the artboard, in CSS px.
export const buildTextData = ({ content, style, box, scale }) => {
  const fontSize = px(style.fontSize, 16)
  const lineHeight = style.lineHeight === "normal" || style.lineHeight == null ? fontSize * 1.2 : px(style.lineHeight, fontSize * 1.2)
  const letterSpacing = style.letterSpacing ?? "0"
  const tracking = letterSpacing.endsWith("em") ? px(letterSpacing, 0) * 1000 : (px(letterSpacing, 0) / fontSize) * 1000
  const align = ["center", "right", "end"].includes(style.textAlign) ? (style.textAlign === "end" ? "right" : style.textAlign) : "left"
  const text = applyTransform(content.replace(/\r\n?/g, "\n"), style.textTransform)
  const lines = Math.max(1, Math.round(box.height / lineHeight))

  // CSS centres each line in its line box; Photoshop measures from the baseline. ~0.35em below centre fits most fonts.
  const firstBaseline = box.y + lineHeight / 2 + fontSize * 0.35
  const anchorX = align === "center" ? box.x + box.width / 2 : align === "right" ? box.x + box.width : box.x

  const textData = {
    text,
    antiAlias: "smooth",
    style: {
      font: { name: postScriptName(firstFamily(style.fontFamily), px(style.fontWeight, 400), style.fontStyle === "italic") },
      fontSize: fontSize * scale,
      leading: lineHeight * scale,
      autoLeading: false,
      tracking: Math.round(tracking),
      fillColor: parseColor(style.color),
    },
    paragraphStyle: { justification: align },
  }

  if (lines > 1) {
    // Wrapping text becomes a paragraph box; a little extra width absorbs font metric differences.
    const slack = fontSize * 0.5
    const left = align === "center" ? box.x - slack / 2 : align === "right" ? box.x - slack : box.x
    const top = firstBaseline - fontSize * 0.95
    return {
      ...textData,
      shapeType: "box",
      transform: [1, 0, 0, 1, left * scale, top * scale],
      boxBounds: [0, 0, (box.width + slack) * scale, (box.height + lineHeight) * scale],
    }
  }

  return { ...textData, shapeType: "point", transform: [1, 0, 0, 1, anchorX * scale, firstBaseline * scale] }
}
