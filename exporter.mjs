// Talks to Paper's local MCP server and turns artboards into layered PSD files.
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { writePsdBuffer } from "ag-psd"
import { PNG } from "pngjs"
import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { resolveTextStyle, buildTextData } from "./text-layer.mjs"
import { blurRadius, withoutBlur, buildSmartLayer } from "./smart-blur.mjs"
import { shapeLayerProps, hasBoxShadow } from "./shape-layer.mjs"

export const DEFAULT_OUT = join(homedir(), "Downloads")
// The Paper desktop app serves MCP on this local port on both macOS and Windows.
const PAPER_URL = process.env.PAPER_URL ?? "http://127.0.0.1:29979/mcp"

export const connect = async () => {
  const client = new Client({ name: "paper-psd", version: "1.0.0" })
  await client.connect(new StreamableHTTPClientTransport(new URL(PAPER_URL)))

  // Paper replies with a file header block followed by the payload block.
  const raw = async (name, args) => {
    const res = await client.callTool({ name, arguments: args })
    const texts = res.content.filter((c) => c.type === "text").map((c) => c.text)
    if (res.isError) throw new Error(`${name}: ${texts.join("\n")}`)
    return { header: JSON.parse(texts[0]), body: JSON.parse(texts.at(-1)) }
  }
  const call = async (name, args) => (await raw(name, args)).body

  const getOverview = async (pageId) => {
    const { header, body } = await raw("get_basic_info", pageId ? { pageId } : {})
    return { file: header.file, pageId: body.pageId, pageName: body.pageName, pages: body.pages, artboards: body.artboards }
  }

  const getSelectedArtboardIds = async () => {
    const sel = await call("get_selection", {})
    return (sel.selectedNodes ?? []).map((n) => n.artboardId ?? n.id)
  }

  // Paper occasionally returns no file when an export lands right after a style change, so retry briefly.
  const exportPng = async (fileId, nodeId, scale, attempt = 1) => {
    const res = await call("export", { fileId, nodes: { [nodeId]: [{ format: "png", scale: `${scale}x` }] } })
    const path = res.exports?.[0]?.filePath
    if (!path && attempt < 4) {
      await new Promise((resolve) => setTimeout(resolve, 150 * attempt))
      return exportPng(fileId, nodeId, scale, attempt + 1)
    }
    if (!path) throw new Error(`Export of ${nodeId} returned no file`)
    const png = PNG.sync.read(readFileSync(path))
    unlinkSync(path)
    return png
  }

  const toImageData = (png) => ({ width: png.width, height: png.height, data: new Uint8ClampedArray(png.data) })

  // Trim a full-artboard render down to its visible pixels so each layer has tight bounds.
  const cropToContent = (png) => {
    const { width: w, height: h, data } = png
    let minX = w, minY = h, maxX = -1, maxY = -1
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] === 0) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
    if (maxX < 0) return null
    const cw = maxX - minX + 1, ch = maxY - minY + 1, out = new Uint8ClampedArray(cw * ch * 4)
    for (let y = 0; y < ch; y++) out.set(data.subarray(((y + minY) * w + minX) * 4, ((y + minY) * w + maxX + 1) * 4), y * cw * 4)
    return { left: minX, top: minY, imageData: { width: cw, height: ch, data: out } }
  }

  // Reads the artboard's layer tree. With nested on, frames are expanded into groups; everything else is a single layer.
  const loadTree = async (fileId, nodeId, nested) => {
    const { children } = await call("get_children", { fileId, nodeId })
    return Promise.all(children.map(async (c) => {
      const info = await call("get_node_info", { fileId, nodeId: c.id })
      const expand = nested && c.component === "Frame" && c.childCount > 0 && info.isVisible !== false
      return { ...c, hidden: info.isVisible === false, worldX: info.worldX, worldY: info.worldY, width: info.width, height: info.height, textContent: info.textContent, kids: expand ? await loadTree(fileId, c.id, nested) : null }
    }))
  }

  const PAINTLESS = { backgroundColor: "transparent", backgroundImage: "none", boxShadow: "none", borderColor: "transparent", outlineColor: "transparent" }

  const flatten = (tree) => tree.flatMap((n) => [n, ...(n.kids ? flatten(n.kids) : [])])

  // Layers are rendered one at a time on a temporary copy of the artboard, with everything else faded to 0 opacity,
  // so shadows and overflowing text keep their full extent. The copy is always deleted afterwards.
  const exportArtboard = async ({ fileId, artboard, scale = 1, outDir = DEFAULT_OUT, background = true, nested = true, onProgress = () => {} }) => {
    const composite = await exportPng(fileId, artboard.id, scale)
    const tree = await loadTree(fileId, artboard.id, nested)
    const all = flatten(tree)
    const { styles } = await call("get_computed_styles", { fileId, nodeIds: [artboard.id, ...all.map((n) => n.id)] })
    const opacityOf = (n) => {
      const value = parseFloat(styles[n.id]?.opacity)
      return Number.isFinite(value) ? value : 1
    }
    const total = all.length + (background ? 1 : 0)
    let done = 0
    const step = (layer, extra = {}) => onProgress({ layer, done: ++done, total, ...extra })

    const dup = await call("duplicate_nodes", { fileId, nodes: [{ id: artboard.id }] })
    const copy = dup.duplicatedNodes?.[0]
    if (!copy?.newId) throw new Error("Could not create temporary artboard copy")
    const copyOf = (n) => copy.descendantIdMap[n.id]
    const setOpacity = (nodes, opacity) => nodes.length
      ? call("update_styles", { fileId, updates: [{ nodeIds: nodes.map(copyOf), styles: { opacity } }] })
      : null
    // After a frame's own paint is captured as its "fill" layer, remove it so its children render alone.
    const stripPaint = (n) => call("update_styles", { fileId, updates: [{ nodeIds: [copyOf(n)], styles: PAINTLESS }] })
    const renderCopy = async () => cropToContent(await exportPng(fileId, copy.newId, scale))

    // Hidden layers render nothing on the canvas, so export the node itself at its own bounds.
    const renderHidden = async (n) => {
      const png = await exportPng(fileId, n.id, scale)
      const left = n.worldX != null && artboard.worldX != null ? n.worldX - artboard.worldX : n.x ?? 0
      const top = n.worldY != null && artboard.worldY != null ? n.worldY - artboard.worldY : n.y ?? 0
      return { left: Math.round(left * scale), top: Math.round(top * scale), imageData: toImageData(png) }
    }

    // Siblings arrive faded out; their parent chain is visible at its real opacity.
    // Text nodes keep their raster for an exact look, plus type data so Photoshop can edit them.
    const textFor = (n, parents) => {
      if (n.component !== "Text" || !n.textContent || n.worldX == null || artboard.worldX == null) return {}
      const style = resolveTextStyle([n.id, ...parents, artboard.id].map((id) => styles[id]))
      const box = { x: n.worldX - artboard.worldX, y: n.worldY - artboard.worldY, width: n.width, height: n.height }
      return { text: buildTextData({ content: n.textContent, style, box, scale }) }
    }

    // Blurred text: render it again with the blur switched off, and wrap it in a Smart Object that re-applies the blur.
    const linkedFiles = []
    const filterEffectsMasks = []
    const blurredByOf = (n, parents) => [n.id, ...parents].filter((id) => blurRadius(styles[id]?.filter) > 0)
    const boxOf = (n) => n.worldX == null || artboard.worldX == null || n.width == null ? null : {
      x: (n.worldX - artboard.worldX) * scale,
      y: (n.worldY - artboard.worldY) * scale,
      width: n.width * scale,
      height: n.height * scale,
    }
    const isBox = (n) => n.component === "Frame" || n.component === "Rectangle"
    // Inside blurred Smart Objects only opaque, unsplit boxes become shapes; the pixels there come from a single render.
    const shapeFor = (n) => {
      const shape = isBox(n) ? shapeLayerProps(styles[n.id]) : null
      return shape && !shape.solidFill && !shape.needsSplit ? shape : null
    }

    // Plain boxes become shape layers. Their shadows become layer effects, so the pixels are re-rendered without them.
    // Returns a list of layers (a see-through fill with a border becomes separate fill and border layers), or null.
    const restyle = (n, styles) => call("update_styles", { fileId, updates: [{ nodeIds: [copyOf(n)], styles }] })
    const shapeLayers = async (n, name, pixels) => {
      const shape = isBox(n) ? shapeLayerProps(styles[n.id], { allowShadow: true }) : null
      const box = shape && boxOf(n)
      if (!box) return null
      if (hasBoxShadow(styles[n.id])) await restyle(n, { boxShadow: "none" })
      if (shape.solidFill) await restyle(n, { backgroundColor: shape.solidFill })
      if (!shape.needsSplit) {
        const own = hasBoxShadow(styles[n.id]) || shape.solidFill ? await renderCopy() : pixels
        return own ? [{ name, ...own, ...shape(box, scale) }] : null
      }
      await restyle(n, { borderColor: "transparent" })
      const fillPixels = await renderCopy()
      await restyle(n, { borderColor: styles[n.id].borderColor, backgroundColor: "transparent" })
      const borderPixels = await renderCopy()
      return [
        ...(fillPixels ? [{ name: `${name} · fill`, ...fillPixels, ...shape(box, scale, "fill") }] : []),
        ...(borderPixels ? [{ name: `${name} · border`, ...borderPixels, ...shape(box, scale, "border") }] : []),
      ]
    }

    const renderSmart = async ({ n, name, opacity, blurred, blurredBy, text, shape }) => {
      const setFilters = (pick) => call("update_styles", {
        fileId,
        updates: blurredBy.map((id) => ({ nodeIds: [copy.descendantIdMap[id]], styles: { filter: pick(styles[id].filter) } })),
      })
      await setFilters(withoutBlur)
      let sharp
      try {
        sharp = await renderCopy()
      } finally {
        await setFilters((f) => f)
      }
      if (!sharp) return { name, opacity, ...blurred, ...(text && { text }) }
      // Stacked blurs combine like Gaussians: radii add in quadrature.
      const radius = Math.sqrt(blurredBy.reduce((sum, id) => sum + blurRadius(styles[id].filter) ** 2, 0)) * scale
      const box = shape ? boxOf(n) : null
      const inner = text
        ? (dx, dy) => ({ text: { ...text, transform: [...text.transform.slice(0, 4), text.transform[4] + dx, text.transform[5] + dy] } })
        : box
          ? (dx, dy) => shape({ ...box, x: box.x + dx, y: box.y + dy }, scale)
          : undefined
      const growRoom = text ? Math.round(sharp.imageData.width * 0.25) : 0
      const { layer, linkedFile, filterMask } = buildSmartLayer({ name, opacity, sharp, blurred, radius, inner, box, growRoom, doc: { width: composite.width, height: composite.height } })
      linkedFiles.push(linkedFile)
      filterEffectsMasks.push(filterMask)
      return layer
    }

    const renderLevel = async (nodes, parents = []) => {
      const layers = []
      for (const n of nodes) {
        try {
          if (n.hidden) {
            layers.push({ name: n.name, hidden: true, ...await renderHidden(n), ...textFor(n, parents) })
            step(n.name)
            continue
          }
          // Render at full strength; the node's opacity goes on the PSD layer so edits keep it.
          await setOpacity([n], 1)
          if (n.kids) {
            await setOpacity(n.kids, 0)
            const fill = await renderCopy()
            const fillName = `${n.name} fill`
            const fillBlurredBy = blurredByOf(n, parents)
            const fillLayers = !fill ? [] : fillBlurredBy.length
              ? [await renderSmart({ n, name: fillName, opacity: 1, blurred: fill, blurredBy: fillBlurredBy, shape: shapeFor(n) })]
              : (await shapeLayers(n, fillName, fill)) ?? [{ name: fillName, ...fill }]
            await stripPaint(n)
            step(n.name)
            const children = [...fillLayers, ...await renderLevel(n.kids, [n.id, ...parents])]
            if (children.length) layers.push({ name: n.name, opened: false, opacity: opacityOf(n), children })
          } else {
            const layer = await renderCopy()
            const { text } = textFor(n, parents)
            const blurredBy = blurredByOf(n, parents)
            if (layer && blurredBy.length) {
              layers.push(await renderSmart({ n, name: n.name, opacity: opacityOf(n), blurred: layer, blurredBy, text, shape: text ? null : shapeFor(n) }))
            } else if (layer && text) {
              layers.push({ name: n.name, opacity: opacityOf(n), ...layer, text })
            } else if (layer) {
              const shaped = (await shapeLayers(n, n.name, layer)) ?? [{ name: n.name, ...layer }]
              layers.push(shaped.length === 1
                ? { opacity: opacityOf(n), ...shaped[0] }
                : { name: n.name, opened: false, opacity: opacityOf(n), children: shaped })
            }
            step(n.name, layer ? {} : { error: "empty, skipped" })
          }
          await setOpacity([n], 0)
        } catch (err) {
          step(n.name, { error: err.message })
        }
      }
      return layers
    }

    const layers = []
    try {
      await setOpacity(tree, 0)
      if (background) {
        const bg = await exportPng(fileId, copy.newId, scale)
        layers.push({ name: "Background", left: 0, top: 0, imageData: toImageData(bg) })
        step("Background")
      }
      await call("update_styles", { fileId, updates: [{ nodeIds: [copy.newId], styles: PAINTLESS }] })
      layers.push(...await renderLevel(tree))
    } finally {
      await call("delete_nodes", { fileId, nodeIds: [copy.newId] })
    }

    const psd = { width: composite.width, height: composite.height, imageData: toImageData(composite), children: layers, ...(linkedFiles.length && { linkedFiles, filterEffectsMasks, filterMask: { colorSpace: { r: 255, g: 0, b: 0 }, opacity: 0.5 } }) }
    mkdirSync(outDir, { recursive: true })
    const safeName = artboard.name.replace(/[/\\:*?"<>|]/g, "-")
    const outPath = resolve(outDir, `${safeName}${scale === 1 ? "" : `@${scale}x`}.psd`)
    writeFileSync(outPath, writePsdBuffer(psd, { generateThumbnail: false }))
    return outPath
  }

  // Small PNG preview of an artboard, returned as bytes.
  const thumbnail = async (fileId, nodeId) => {
    const res = await call("export", { fileId, nodes: { [nodeId]: [{ format: "png", scale: "320w" }] } })
    const path = res.exports?.[0]?.filePath
    if (!path) throw new Error(`Thumbnail of ${nodeId} returned no file`)
    const bytes = readFileSync(path)
    unlinkSync(path)
    return bytes
  }

  return { getOverview, getSelectedArtboardIds, exportArtboard, thumbnail, close: () => client.close() }
}
