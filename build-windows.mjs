// Builds "Paper to PSD.exe": the app bundled into the official Windows Node.js runtime as a single executable.
// Run with the same Node version as NODE_VERSION: node build-windows.mjs
import { build } from "esbuild"
import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs"
import { createHash } from "node:crypto"
import * as ResEdit from "resedit"
import { buildIco } from "./icon.mjs"

const NODE_VERSION = "22.22.2"
const VERSION = JSON.parse(readFileSync("package.json", "utf8")).version
const OUT = "build"
const EXE = `${OUT}/Paper to PSD.exe`
const SEA_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"

if (process.version !== `v${NODE_VERSION}`) throw new Error(`Build with Node ${NODE_VERSION} (running ${process.version})`)
mkdirSync(OUT, { recursive: true })

// 1. Official Windows runtime, checked against nodejs.org's published checksum.
const zip = `${OUT}/node-v${NODE_VERSION}-win-x64.zip`
if (!existsSync(zip)) execFileSync("curl", ["-fsSL", "-o", zip, `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-win-x64.zip`])
const sums = execFileSync("curl", ["-fsSL", `https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt`]).toString()
const expected = sums.split("\n").find((line) => line.endsWith(`node-v${NODE_VERSION}-win-x64.zip`))?.split(/\s+/)[0]
if (createHash("sha256").update(readFileSync(zip)).digest("hex") !== expected) throw new Error("node.exe download doesn't match nodejs.org checksum")
const nodeExe = execFileSync("unzip", ["-p", zip, `node-v${NODE_VERSION}-win-x64/node.exe`], { maxBuffer: 256 * 1024 * 1024 })

// 2. Bundle the app into one CommonJS file, the format single executables run.
await build({
  entryPoints: ["server.mjs"],
  outfile: `${OUT}/app.cjs`,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: `node${NODE_VERSION.split(".")[0]}`,
  // Only used outside the packaged app, where the page is read from disk.
  define: { "import.meta.url": "undefined" },
  logLevel: "warning",
})

// 3. Snapshot-free blob so it can be made on macOS for Windows.
writeFileSync(`${OUT}/sea-config.json`, JSON.stringify({
  main: `${OUT}/app.cjs`,
  output: `${OUT}/sea.blob`,
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
  assets: { "index.html": "index.html" },
}))
execFileSync(process.execPath, ["--experimental-sea-config", `${OUT}/sea-config.json`], { stdio: "inherit" })

// 4. App name, version, icon and the embedded app; Node's signature is dropped since the file changes.
const exe = ResEdit.NtExecutable.from(nodeExe, { ignoreCert: true })
const res = ResEdit.NtExecutableResource.from(exe)
const [iconGroup] = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries)
const icons = ResEdit.Data.IconFile.from(buildIco()).icons.map((icon) => icon.data)
ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, iconGroup.id, iconGroup.lang, icons)
const [info] = ResEdit.Resource.VersionInfo.fromEntries(res.entries)
const [lang] = info.getAllLanguagesForStringValues()
for (const key of ["CompanyName", "LegalCopyright", "Comments"]) info.removeStringValue(lang, key)
info.setStringValues(lang, {
  ProductName: "Paper to PSD",
  FileDescription: "Paper to PSD",
  InternalName: "Paper to PSD",
  OriginalFilename: "Paper to PSD.exe",
  FileVersion: VERSION,
  ProductVersion: VERSION,
})
info.setFileVersion(VERSION)
info.setProductVersion(VERSION)
info.outputToResourceEntries(res.entries)
// Node looks the app up as an RCDATA resource named NODE_SEA_BLOB.
const blob = readFileSync(`${OUT}/sea.blob`)
res.entries.push({ type: 10, id: "NODE_SEA_BLOB", lang: iconGroup.lang, codepage: 0, bin: blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.length) })
res.outputResource(exe)
const bytes = Buffer.from(exe.generate())

// 5. Flip the fuse that tells Node an app is embedded.
const fuse = bytes.indexOf(`${SEA_FUSE}:0`)
if (fuse < 0 || bytes.indexOf(`${SEA_FUSE}:`, fuse + 1) >= 0) throw new Error("SEA fuse not found exactly once")
bytes[fuse + SEA_FUSE.length + 1] = "1".charCodeAt(0)

// 6. Windows (GUI) subsystem instead of console, so no terminal window opens next to the app.
const peHeader = bytes.readUInt32LE(0x3c)
const optionalHeader = peHeader + 24
if (bytes.readUInt32LE(peHeader) !== 0x4550 || bytes.readUInt16LE(optionalHeader) !== 0x20b) throw new Error("Unexpected PE layout")
bytes.writeUInt16LE(2, optionalHeader + 68)
rmSync(EXE, { force: true })
writeFileSync(EXE, bytes)

const zipOut = `${OUT}/Paper to PSD (Windows).zip`
rmSync(zipOut, { force: true })
execFileSync("zip", ["-9", "-q", "-j", zipOut, EXE])
console.log(`Built ${EXE} (${(bytes.length / 1024 / 1024).toFixed(1)} MB) and ${zipOut}`)
