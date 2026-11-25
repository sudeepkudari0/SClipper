#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

bash scripts/make-sample.sh
pnpm build

E2E_WS="$(mktemp -d)"
trap 'rm -rf "$E2E_WS"' EXIT

TODAY="$(date +%Y-%m-%d)"
rm -rf "out/cnpl/${TODAY}"

echo "=== Running clipper pipeline on samples (--no-llm) ==="
node dist/cli.js --campaign cnpl --workspace "$E2E_WS" run sources/e2e --no-llm --variants 1 --force

OUT_DIR="out/cnpl/${TODAY}"
if [ ! -f "${OUT_DIR}/captions.md" ]; then
  echo "FAIL: captions.md missing in ${OUT_DIR}"
  exit 1
fi

MP4_COUNT=$(find "$OUT_DIR" -maxdepth 1 -name '*.mp4' | wc -l)
if [ "$MP4_COUNT" -ne 2 ]; then
  echo "FAIL: Expected 2 exported mp4 files, found ${MP4_COUNT}"
  exit 1
fi

for f in "$OUT_DIR"/*.mp4; do
  PROBE=$(ffprobe -v quiet -print_format json -show_format -show_streams "$f")
  W=$(node -e "const d=JSON.parse(process.argv[1]); const v=d.streams.find(s=>s.codec_type==='video'); console.log(v.width);" "$PROBE")
  H=$(node -e "const d=JSON.parse(process.argv[1]); const v=d.streams.find(s=>s.codec_type==='video'); console.log(v.height);" "$PROBE")
  DUR=$(node -e "const d=JSON.parse(process.argv[1]); console.log(Number(d.format.duration));" "$PROBE")
  echo "Checked $f: ${W}x${H}, duration=${DUR}s"
  if [ "$W" != "1080" ] || [ "$H" != "1920" ]; then
    echo "FAIL: Expected 1080x1920, got ${W}x${H}"
    exit 1
  fi
  node -e "const d=Number(process.argv[1]); if(d<8||d>60) process.exit(1);" "$DUR"
done

echo "=== Verifying explicit validate passes ==="
node dist/cli.js --campaign cnpl --workspace "$E2E_WS" validate

echo "=== Verifying broken copy fails validate ==="
FIRST_CLIP_DIR=$(find "${E2E_WS}/cnpl" -mindepth 1 -maxdepth 1 -type d | head -n 1)
FIRST_CLIP_ID=$(basename "$FIRST_CLIP_DIR")
node -e '
  const fs = require("fs");
  const p = process.argv[1] + "/copy.json";
  const c = JSON.parse(fs.readFileSync(p, "utf8"));
  c.captions.tiktok = "Broken caption without required tags #wrongtag";
  fs.writeFileSync(p, JSON.stringify(c, null, 2));
' "$FIRST_CLIP_DIR"

if node dist/cli.js --campaign cnpl --workspace "$E2E_WS" validate "$FIRST_CLIP_ID"; then
  echo "FAIL: validate should have failed on broken copy.json"
  exit 1
else
  echo "PASS: validate correctly failed on broken copy.json"
fi

echo "=== E2E PASSED ==="

