# clipper

A campaign-aware CLI that turns source footage into upload-ready vertical (`9:16`) clips, drafts grounded hooks and platform captions, validates outputs against campaign rules, and packages everything for manual upload.

## Requirements

- **Node.js 22+** and **pnpm**
- **ffmpeg** and **ffprobe** on `PATH` (optional NVENC hardware encoding via `h264_nvenc`; automatically falls back to `libx264`)
- **fontconfig** (`fc-match`) with a bold sans-serif font installed (prefers `Open Sans` / `Noto Sans`)
- **Mistral API key** (for LLM hooks/captions, vision, moments, and transcription; `--no-llm` works offline using templates)
- **yt-dlp** (optional, for `sources.fetch` when pulling artist clips from YouTube/TikTok)
- **Pexels API key** (optional, for `clipper stock` / `clipper run --stock "..."`)

## Install

```bash
pnpm install
pnpm build
# Optional: link globally
pnpm link --global
```

## `.env` Setup

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Set your Mistral API key and optional per-task model overrides:

```env
MISTRAL_API_KEY=your_key_here

# Optional global or per-task model overrides
# MISTRAL_MODEL=ministral-8b-2512
# MISTRAL_MODEL_PLAN=ministral-8b-2512
# MISTRAL_MODEL_MOMENTS=ministral-8b-2512
# MISTRAL_MODEL_DRAFT=ministral-8b-2512
# MISTRAL_MODEL_VISION=ministral-8b-2512
# MISTRAL_MODEL_TRANSCRIBE=voxtral-mini-latest

MISTRAL_MIN_INTERVAL_MS=2000
# WHISPER_CMD="whisper-cli -m /path/to/model.bin -f {wav} -oj -of {out}"

# Optional Pexels API key for `clipper stock` / `clipper run --stock`
# PEXELS_API_KEY=your_pexels_key_here
```

Model resolution order: `--model-<task>` CLI flag > `profile.models.<task>` > `MISTRAL_MODEL_<TASK>` > `MISTRAL_MODEL` > built-in default.

## Quickstart (CNPL Flow)

1. Drop the CNPL watermark icon at `campaigns/cnpl/assets/cnpl_icon.png`.
2. Verify your environment:
   ```bash
   clipper doctor
   ```
3. Set `cnpl` as the active campaign and run the full pipeline:
   ```bash
   clipper use cnpl
   clipper run --fetch
   ```
   (Or point directly at local files: `clipper run ./sources/cnpl --no-llm`)
4. Review the exported `.mp4` files and `captions.md` in `out/cnpl/<YYYY-MM-DD>/`, then upload manually.

## Quickstart (Naya Yeira Song EP Flow)

1. Set `naya-yeira` as active:
   ```bash
   clipper use naya-yeira
   ```
2. Run with both artist shorts (`--fetch` via `yt-dlp`) and a Pexels stock drop-cut montage (`--stock`):
   ```bash
   clipper run --fetch --stock "night drive rain" --context "Hit Record — Naya Yeira: POV documenting rock bottom"
   ```
3. Outputs in `out/naya-yeira/<YYYY-MM-DD>/` are muted (`output.audio: mute`) and `>= 15s` with `dropAtSec: 3.0`, ready to attach the official sound in TikTok/Instagram with `@nayayeiraofficial` / `@nayayeira` and `Hit Record — Naya Yeira` in `captions.md`.

## Command Reference

| Command | Description |
| --- | --- |
| `clipper doctor` | Check `ffmpeg`, `ffprobe`, NVENC, fonts, `MISTRAL_API_KEY`, and configured models |
| `clipper models` | List available Mistral models (`GET /v1/models`) and task-to-model mapping |
| `clipper campaign init <name>` | Scaffold `campaigns/<name>/profile.yaml` and `assets/` |
| `clipper campaign draft --brief <file> --name <name>` | Draft a campaign `profile.yaml` from a brief (`.txt`, `.md`, `.pdf`) |
| `clipper use <name>` | Set the active campaign (`workspace/.active`) |
| `clipper fetch` | Run the profile's `sources.fetch` shell template |
| `clipper ingest [path]` | Probe and register source videos into `workspace/<campaign>/` |
| `clipper analyze [clipId]` | Audio onset, motion centroid, scene cuts, window selection, optional `--vision` |
| `clipper transcribe [clipId]` | Transcribe long-form audio (`mistral` or `whisper-cmd`) |
| `clipper moments [clipId]` | Rank top candidate moments from transcript into child clips |
| `clipper plan [clipId]` | Generate grounded hooks & platform captions (`--context`, `--no-llm`) |
| `clipper render [clipId]` | Render `9:16` variants (`--variants N`, `--reframe`, `--slowmo`, `--zoom`, `--counter`) |
| `clipper validate [clipId]` | Validate renders and copy against campaign rules |
| `clipper export` | Copy passing renders to `out/` and generate `captions.md` |
| `clipper run [path]` | Run the full pipeline end-to-end (`--top N`, `--limit N`, `--fetch`, `--stock <query>`, `--force`) |
| `clipper stock` | Download portrait HD B-roll clips from Pexels (`--query`, `--count`, `--orientation`) |
| `clipper montage` | Stitch stock clips into a vertical montage with short-form-paced `xfade` transitions |
| `clipper log` | Log posted clip views, payout, and time spent to `ledger.csv` |
| `clipper report` | Print totals (views, payout, `$/hour`) per platform |

Global options: `--campaign / -c <name>`, `--workspace <dir>`, `--json`, `--model-<task> <id>`.

## Decisions

- **Env loading**: Implemented a lightweight zero-dependency `.env` loader in `src/core/env.ts` instead of adding `dotenv`.
- **Reframe pan expression**: Motion-tracked horizontal reframing uses EMA smoothing + deadzone + max pan speed, downsampled to 2 Hz keyframes and compiled into an `ffmpeg` `crop=x='if(lt(t,...))'` piecewise linear expression so no external `sendcmd` file escaping is needed.
- **Watermark visual verification**: Samples 5 frames and compares opaque watermark pixels (`alpha >= 200`) against the ROI with a 45/255 MAE threshold (accounting for `yuv420p` chroma subsampling). If inconclusive (e.g., semi-transparent or occluded), it downgrades to `manifest-only` with an explicit warning rather than a silent pass.
- **PDF brief ingestion**: Uses `pdftotext` when `.pdf` is passed to `clipper campaign draft`, failing with a clear message if `pdftotext` is not installed.
- **Audio when source has no audio**: If `output.audio: keep` and the source file lacks an audio stream, rendering produces `-an` and `validate` flags the missing audio stream cleanly.
- **Mistral free-tier rate limits**: Built-in defaults use `ministral-8b-2512` (2 RPM / 40k TPM on free tier) and `MistralClient` reads `x-ratelimit-remaining-req-minute` to pace requests automatically.
- **Song/EP campaigns**: Added `output.dropAtSec`, `captions.platformMentions`, `captions.requiredPhrases`, Pexels `stock` fetching, and short-form-paced `xfade` montage stitching so music-promotion campaigns (in-app audio only) are supported alongside sports/podcast campaigns.
- **Hook typography & dark-scene validation**: Hooks use large mobile-first typography, phrase-aware `\N` wrapping (`WrapStyle: 0`), a high-contrast punchy box variant, second-line accent color, 100ms fades, and `cropdetect` threshold `10` to avoid false-positive black-bar failures on dark night footage.

## Rules the Tool Cannot Verify

- **Official footage provenance**: The tool assumes files in `sources/<campaign>` are official campaign footage.
- **One account per platform & account age**: Platform account eligibility and single-account rules must be enforced manually.
- **Audience geography proof**: Capturing and submitting platform analytics screenshots is manual.
- **Uniqueness vs. other clippers**: The tool cannot check whether another clipper has already uploaded the same rally.
- **In-app music selection**: `clipper` never bakes music when `bans.bakedMusic: true`; you must add in-app audio manually during upload.

