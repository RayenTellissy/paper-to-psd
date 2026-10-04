// macOS and Windows versions of the few things that touch the desktop: folder picker, file reveal, app window.
import { execFile, spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"

const isWindows = process.platform === "win32"

const run = (file, args, options = {}) => new Promise((resolve) => {
  execFile(file, args, { windowsHide: true, ...options }, (err, stdout) => resolve(err ? null : stdout.toString().trim()))
})

const powershell = (script) => run("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-Command", script])

export const revealLabel = isWindows ? "Show in Explorer" : "Show in Finder"

export const pickFolder = async () => {
  if (!isWindows) return run("osascript", ["-e", 'POSIX path of (choose folder with prompt "Save PSD files to")'])
  // A hidden topmost owner keeps the dialog in front of the app window.
  const path = await powershell([
    "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
    "Add-Type -AssemblyName System.Windows.Forms",
    "$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false }",
    "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
    "$dialog.Description = 'Save PSD files to'",
    "if ($dialog.ShowDialog($owner) -eq 'OK') { $dialog.SelectedPath }",
  ].join("; "))
  return path || null
}

export const reveal = (path) => {
  if (isWindows) execFile("explorer.exe", [`/select,"${path}"`], { windowsVerbatimArguments: true })
  else execFile("open", ["-R", path])
}

const CHROMIUM = /\\(chrome|msedge|brave|vivaldi|opera|chromium)\.exe$/i

// The exe registered for the user's default browser, read from the registry.
const defaultBrowserExe = async () => {
  const choice = await run("reg.exe", ["query", "HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice", "/v", "ProgId"])
  const progId = choice?.match(/ProgId\s+REG_SZ\s+(.+)/)?.[1]?.trim()
  if (!progId) return null
  const command = await run("reg.exe", ["query", `HKCR\\${progId}\\shell\\open\\command`, "/ve"])
  return command?.match(/REG_SZ\s+"([^"]+\.exe)"/i)?.[1] ?? null
}

const edgeExe = () => [process.env["ProgramFiles(x86)"], process.env.ProgramFiles, process.env.LOCALAPPDATA]
  .filter(Boolean)
  .map((dir) => join(dir, "Microsoft", "Edge", "Application", "msedge.exe"))
  .find((path) => existsSync(path))

// Opens the UI as a standalone app window: the default browser if it's Chromium-based, otherwise Edge.
export const openAppWindow = async (url) => {
  if (!isWindows) return execFile("open", [url])
  const preferred = await defaultBrowserExe()
  const browser = preferred && CHROMIUM.test(preferred) ? preferred : edgeExe()
  if (browser) {
    spawn(browser, [`--app=${url}`, "--window-size=1120,780"], { detached: true, stdio: "ignore" }).unref()
    return
  }
  execFile("cmd.exe", ["/c", "start", "", url], { windowsHide: true })
}
