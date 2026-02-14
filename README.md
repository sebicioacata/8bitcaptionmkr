# 8-Bit Dialogue Caption Maker

A browser-first tool for creating retro dialogue overlays for gameplay clips.
Designed for reels/shorts workflows with a pixel-art dialogue box, timed cues, and one-click overlay export.

## Highlights

- Reels-first canvas (`1080x1920`, 9:16) with optional source-size output
- Retro dialogue box renderer with selectable box styles
- Timed caption cues with live list editing
- Mini timeline with drag-to-move and drag-to-resize cues
- Keyboard shortcuts for fast preview control
- Overlay export (chroma key) or composite export (burned-in preview)
- Pixel controls for both box scale and text granularity

## Tech Stack

- Vanilla JavaScript (ES modules)
- HTML5 Canvas for frame rendering
- MediaRecorder API for export

## Project Structure

```text
.
├── index.html
├── styles.css
├── src
│   ├── main.js       # App orchestration, events, export pipeline
│   ├── renderer.js   # Caption rendering engine (box + text + effects)
│   ├── timeline.js   # Mini timeline UI + cue drag/resize interactions
│   └── utils.js      # Shared helpers
└── README.md
```

## Run Locally

### Option A: Python static server

```bash
cd /Users/sebastian/ws/8bitcaptionmkr
python3 -m http.server 1234
```

Open: [http://127.0.0.1:1234](http://127.0.0.1:1234)

### Option B: Live reload (recommended during editing)

```bash
cd /Users/sebastian/ws/8bitcaptionmkr
npx --yes live-server . --port=1235 --no-browser
```

Open: [http://127.0.0.1:1235](http://127.0.0.1:1235)

## Keyboard Shortcuts

- `Space`: play/pause
- `S`: jump to start
- `M`: toggle mute

## Usage

1. Load a source video.
2. Add dialogue cues with start/end times.
3. Fine-tune visual style (box style, pixel scale, text pixelation).
4. Optionally drag cues in the mini timeline to retime quickly.
5. Export:
   - `Overlay export`: green-screen dialogue layer
   - `Composite export`: source + dialogue for preview delivery

## Export Notes

- Output format is `.webm` for browser-native rendering.
- To convert to `.mp4`:

```bash
ffmpeg -i input.webm -c:v libx264 -pix_fmt yuv420p -c:a aac output.mp4
```
