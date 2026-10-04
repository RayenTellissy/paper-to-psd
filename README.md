# Paper to PSD

Export [Paper](https://paper.design) artboards as layered Photoshop files.

- **Editable text** — text nodes become Photoshop text layers (font, size, leading, tracking, colour, alignment).
- **Shape layers** — plain boxes become vector shape layers with rounded corners, borders (solid or dashed) and drop/inner shadows as layer effects.
- **Live blur** — blurred text and shapes become Smart Objects with a Gaussian Blur smart filter, so they stay editable and keep their blur.
- **Groups** — frames become layer groups; everything else (images, gradients, SVG icons) is exported as pixel layers with shadows and overflow intact.
- 1x / 2x / 3x scale, grouped or flat layers, optional background layer.

## Use it

Download the app for your system from [Releases](../../releases), open the Paper desktop app with your file, then open **Paper to PSD**. Pick artboards and click **Export**.

- **macOS** — unzip and move *Paper to PSD.app* to Applications. Needs [Node.js](https://nodejs.org) installed. The app isn't notarized, so the first time right-click it and choose **Open**.
- **Windows** — unzip and run *Paper to PSD.exe*. Nothing else to install. It isn't code-signed, so Windows may show "Windows protected your PC": click **More info → Run anyway**.

The app runs a small local server on `127.0.0.1:47823` and talks to Paper through Paper's local MCP endpoint (`http://127.0.0.1:29979/mcp`). It quits on its own two minutes after its window is closed. On Windows, errors are logged to `%TEMP%\paper-to-psd.log`.

## Develop

```bash
npm install
node server.mjs --open
```

| File | What it does |
| --- | --- |
| `exporter.mjs` | Talks to Paper, renders each node, assembles the PSD |
| `text-layer.mjs` | CSS text styles → Photoshop text layers |
| `shape-layer.mjs` | CSS boxes → vector shape layers and shadow effects |
| `smart-blur.mjs` | Blurred content → Smart Objects with a Gaussian Blur filter |
| `server.mjs`, `index.html` | The app's local server and UI |
| `platform.mjs` | Folder picker, reveal in Finder/Explorer and app window on macOS and Windows |
| `test.mjs` | Exports one artboard by name to `./out` |
| `verify.mjs` | Flattens a PSD's layers and diffs them against its composite |

### Build

```bash
npm run build:mac       # build/Paper to PSD.app + zip (add -- --install to copy it to /Applications)
npm run build:windows   # build/Paper to PSD.exe + zip; run with Node 22.22.2
```

The Windows build bundles the app into the official Windows Node.js runtime (checksum-verified from nodejs.org) as a single executable, so it can be built on macOS.
