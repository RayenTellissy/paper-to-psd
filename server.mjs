// Local app server: serves the UI and runs exports against the Paper desktop app.
import { createServer } from "node:http"
import { readFileSync, appendFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { connect, DEFAULT_OUT } from "./exporter.mjs"
import { pickFolder, reveal, revealLabel, openAppWindow } from "./platform.mjs"

const PORT = Number(process.env.PORT ?? 47823)
const IDLE_MS = 2 * 60 * 1000
const APP_URL = `http://127.0.0.1:${PORT}`

// Inside the packaged Windows app the page is an embedded asset and there is no console, so errors go to a log file.
const sea = process.getBuiltinModule?.("node:sea")
const packaged = sea?.isSea() ?? false
const html = packaged ? Buffer.from(sea.getAsset("index.html")) : readFileSync(new URL("./index.html", import.meta.url))
const log = (message) => {
  if (packaged) appendFileSync(join(tmpdir(), "paper-to-psd.log"), `${new Date().toISOString()} ${message}\n`)
  else console.log(message)
}
process.on("uncaughtException", (err) => {
  log(err.stack ?? String(err))
  process.exit(1)
})

let paper = null
const getPaper = async () => (paper ??= await connect().catch((err) => {
  paper = null
  throw new Error(`Couldn't reach Paper. Is the Paper app open? (${err.message})`)
}))

// A dropped connection (e.g. Paper restarted) is replaced on the next request.
const dropPaperIfGone = (err) => {
  if (!/fetch failed|ECONNREFUSED|ECONNRESET|session|not connected/i.test(`${err.message} ${err.cause?.code ?? ""}`)) return
  paper?.close().catch(() => {})
  paper = null
}

// Paper writes exports into ~/Downloads by name, so run every Paper job one at a time.
let queue = Promise.resolve()
const serial = (job) => {
  const run = queue.then(job, job)
  queue = run.catch(() => {})
  return run
}

const thumbs = new Map()
let lastSeen = Date.now()
setInterval(() => {
  if (Date.now() - lastSeen > IDLE_MS) process.exit(0)
}, 10_000).unref()

const readBody = async (req) => {
  let body = ""
  for await (const chunk of req) body += chunk
  return body ? JSON.parse(body) : {}
}

const sendJson = (res, status, data) => {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(JSON.stringify(data))
}

const routes = {
  "GET /": (req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    res.end(html)
  },

  "GET /api/ping": (req, res) => sendJson(res, 200, { ok: true }),

  "GET /api/overview": async (req, res, url) => {
    const p = await getPaper()
    const data = await serial(async () => {
      const overview = await p.getOverview(url.searchParams.get("page") || undefined)
      const selected = await p.getSelectedArtboardIds().catch(() => [])
      return { ...overview, selected, defaultOut: DEFAULT_OUT, revealLabel }
    })
    sendJson(res, 200, data)
  },

  "GET /api/thumb": async (req, res, url) => {
    const fileId = url.searchParams.get("file")
    const id = url.searchParams.get("id")
    const key = `${fileId}/${id}/${url.searchParams.get("v") ?? ""}`
    if (!thumbs.has(key)) {
      const p = await getPaper()
      thumbs.set(key, serial(() => p.thumbnail(fileId, id)).catch((err) => {
        thumbs.delete(key)
        throw err
      }))
    }
    const bytes = await thumbs.get(key)
    res.writeHead(200, { "content-type": "image/png", "cache-control": "max-age=60" })
    res.end(bytes)
  },

  "POST /api/choose-folder": async (req, res) => sendJson(res, 200, { path: await pickFolder() }),

  "POST /api/reveal": async (req, res) => {
    const { path } = await readBody(req)
    reveal(path)
    sendJson(res, 200, { ok: true })
  },

  // Streams newline-delimited JSON progress events while exporting.
  "POST /api/export": async (req, res) => {
    const { fileId, artboards, scale, nested, background, outDir } = await readBody(req)
    const p = await getPaper()
    res.writeHead(200, { "content-type": "application/x-ndjson" })
    const emit = (event) => res.write(`${JSON.stringify(event)}\n`)
    await serial(async () => {
      for (const artboard of artboards) {
        emit({ type: "start", id: artboard.id })
        try {
          const path = await p.exportArtboard({
            fileId,
            artboard,
            scale: Number(scale) || 1,
            nested: nested !== false,
            background: background !== false,
            outDir: outDir || DEFAULT_OUT,
            onProgress: (e) => emit({ type: "progress", id: artboard.id, ...e }),
          })
          emit({ type: "done", id: artboard.id, path })
        } catch (err) {
          dropPaperIfGone(err)
          emit({ type: "error", id: artboard.id, error: err.message })
        }
      }
    })
    res.end()
  },
}

createServer(async (req, res) => {
  lastSeen = Date.now()
  const url = new URL(req.url, `http://${req.headers.host}`)
  const route = routes[`${req.method} ${url.pathname}`]
  if (!route) return sendJson(res, 404, { error: "Not found" })
  // Only this app's own page may trigger actions; blocks other websites from calling the local server.
  const origin = req.headers.origin
  if (req.method !== "GET" && origin && origin !== `http://${req.headers.host}`) return sendJson(res, 403, { error: "Forbidden" })
  try {
    await route(req, res, url)
  } catch (err) {
    log(`${req.method} ${url.pathname}: ${err.message}`)
    dropPaperIfGone(err)
    if (!res.headersSent) sendJson(res, 500, { error: err.message })
    else res.end()
  }
})
  .on("error", async (err) => {
    // Already running: just bring up another window for it.
    if (err.code === "EADDRINUSE" && packaged) await openAppWindow(APP_URL)
    else log(err.stack ?? String(err))
    process.exit(err.code === "EADDRINUSE" ? 0 : 1)
  })
  .listen(PORT, "127.0.0.1", () => {
    log(`Paper to PSD running at ${APP_URL}`)
    if (packaged || process.argv.includes("--open")) openAppWindow(APP_URL)
  })
