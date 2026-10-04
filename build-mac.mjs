// Builds "Paper to PSD.app" (AppleScript launcher + bundled server) and a zip of it for releases.
// Usage: node build-mac.mjs [--install]   (--install also copies it to /Applications)
import { execFileSync } from "node:child_process"
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"
import { iconPng } from "./icon.mjs"

const OUT = "build"
const APP = `${OUT}/Paper to PSD.app`
const RESOURCES = `${APP}/Contents/Resources`
const SOURCES = ["exporter.mjs", "text-layer.mjs", "smart-blur.mjs", "shape-layer.mjs", "platform.mjs", "server.mjs", "index.html", "package.json"]

const run = (file, args) => execFileSync(file, args, { stdio: ["ignore", "pipe", "inherit"] }).toString()

mkdirSync(OUT, { recursive: true })
rmSync(APP, { recursive: true, force: true })
run("osacompile", ["-o", APP, "launcher.applescript"])

// App code plus runtime dependencies only (build tools stay out).
const appDir = `${RESOURCES}/app`
for (const file of SOURCES) cpSync(file, join(appDir, file))
const packages = run("npm", ["ls", "--omit=dev", "--all", "--parseable"]).trim().split("\n").slice(1)
for (const dir of packages) cpSync(dir, join(appDir, relative(process.cwd(), dir)), { recursive: true })

// Icon
const iconset = `${OUT}/icon.iconset`
rmSync(iconset, { recursive: true, force: true })
mkdirSync(iconset)
for (const size of [16, 32, 128, 256, 512]) {
  writeFileSync(`${iconset}/icon_${size}x${size}.png`, iconPng(size))
  writeFileSync(`${iconset}/icon_${size}x${size}@2x.png`, iconPng(size * 2))
}
run("iconutil", ["-c", "icns", "-o", `${RESOURCES}/applet.icns`, iconset])
rmSync(iconset, { recursive: true })

run("codesign", ["--force", "--deep", "-s", "-", APP])
const zip = `${OUT}/Paper to PSD (macOS).zip`
rmSync(zip, { force: true })
run("ditto", ["-c", "-k", "--keepParent", APP, zip])

if (process.argv.includes("--install")) {
  rmSync("/Applications/Paper to PSD.app", { recursive: true, force: true })
  run("ditto", [APP, "/Applications/Paper to PSD.app"])
}
console.log(`Built ${APP} and ${zip}`)
