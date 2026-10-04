import { connect } from "./exporter.mjs"
const p = await connect()
const o = await p.getOverview()
const a = o.artboards.find((x) => x.name.includes(process.argv[2] ?? "Build a store"))
console.log(await p.exportArtboard({ fileId: o.file.id, artboard: a, outDir: "./out", onProgress: (e) => e.error && console.log(" ", e.layer, e.error) }))
await p.close()
