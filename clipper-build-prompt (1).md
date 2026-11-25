# Build `clipper`: a campaign-aware CLI that turns source footage into upload-ready vertical clips

## How to work (read first)

- Build the whole project end to end in this repo, without asking me questions. Where something is unspecified, use the default stated here or the simplest sensible option, and record it under "Decisions" in the README.
- When the code is written, run `pnpm typecheck`, `pnpm test` and `scripts/e2e.sh`. Fix every failure yourself. Stop only when all pass, or when a blocker needs a binary I must install (then say exactly which).
- No UI. No auto-posting, uploading, or engagement automation of any kind. The tool prepares files and copy; I upload manually.
- Never invent facts in generated copy (scores, player names, results). Hooks and captions may only use facts supplied via the campaign profile, the CLI `--context` flag, or measured analysis.

## What this is

A personal tool for paid clipping campaigns (Content Rewards / Whop style). A brand supplies footage plus a brief with strict rules. I post clips to TikTok, Instagram Reels and YouTube Shorts from my own accounts and get paid per views. The tool must:

1. Turn footage into compliant vertical clips fast.
2. Draft hooks and captions.
3. Validate each output against the campaign's rules.
4. Package everything for manual upload.

It must work for ANY campaign through a profile file. First campaign: CNPL pickleball (sample profile below), where sources are pre-cut clips under 30 seconds. Second mode: long-form sources (podcasts, streams) where transcript-based moment finding is the main job.

Environment: CachyOS (Arch Linux), NVIDIA laptop GPU (VRAM unknown, 4-8 GB; do not assume), Node 22+, pnpm. `ffmpeg` and `ffprobe` are on PATH and may have NVENC.

## Stack (fixed, do not substitute)

- TypeScript (strict), ESM, Node 22. Package manager: pnpm. Build: tsup. Dev: tsx. Tests: vitest.
- CLI: `commander`. Validation: `zod`. Subprocess: `execa`. YAML: `yaml`. Terminal output: `picocolors`. No other heavy dependencies.
- Binary name: `clipper` (package.json `bin`).
- Video: shell out to ffmpeg/ffprobe. Do all signal analysis in Node by piping raw data from ffmpeg (no Python in v1).
- Text overlays: generate ASS subtitle files and burn them with ffmpeg's `ass` filter. No headless browser.
- Encoding: use `h264_nvenc` if a real 1-second test encode succeeds, otherwise `libx264`. Cache the detection result.
- AI: everything (text, vision, speech-to-text) through the Mistral API via plain `fetch` (see Mistral layer). No local models. State is plain JSON files and CSV. No database in v1.

## Commands

The campaign is a global option, not a positional argument. Resolution order: `--campaign/-c <name>` > active campaign (`clipper use <name>` writes `workspace/.active`) > the only campaign in `campaigns/` if exactly one exists > error listing the available campaigns. Always print "Campaign: <name>" as the first line of every command so I can see which rules are in force.

```
clipper doctor                                   # check ffmpeg, nvenc, fonts, MISTRAL_API_KEY, that every configured model exists, tiny test call per model
clipper models                                   # list models available to my key (GET /v1/models) and show which task uses which
clipper campaign init <name>                     # scaffold campaigns/<name>/profile.yaml + assets/
clipper campaign draft --brief <pdf|txt|md> --name <name>   # LLM drafts a profile from a brief; I review it
clipper use <name>                               # set the active campaign
clipper fetch                                    # run the profile's sources.fetch command to pull footage into sources.localDir
clipper ingest [path]                            # probe + register sources (default path: profile sources.localDir)
clipper analyze [clipId] [--vision]              # audio/motion analysis, window selection, optional frame description
clipper transcribe [clipId]                      # long-form: speech to text
clipper moments [clipId]                         # long-form: LLM ranks candidate moments from transcript
clipper plan [clipId] [--context "..."] [--no-llm]   # hooks + captions per platform
clipper render [clipId] [--variants N] [--reframe auto|center|motion|none] [--slowmo] [--zoom] [--counter] [--no-trim]
clipper validate [clipId]                        # check renders against profile rules
clipper export                                   # copy passing renders to out/ + captions.md checklist
clipper run [path] [--top N] [--limit N] [--fetch] [flags]   # whole pipeline, see below
clipper log --clip <id> --platform <p> --views <n> [--payout <usd>] [--minutes <n>] [--url <u>]
clipper report                                   # totals: views, payout, $/hour, per platform
```

Every command accepts `--workspace <dir>` (default `./workspace`) and `--json` where it makes sense. Commands are idempotent: reuse cached analysis unless `--force`.

### What `clipper run` does

1. Resolve the campaign and load + validate its profile (fail fast with a readable error). Print the key rules in force.
2. If `--fetch`, run `fetch` first. Source files = `[path]` if given, else `sources.localDir`. Scan for video files (mp4, mov, mkv, webm).
3. Skip anything already exported (matched by stable clipId); only new files are processed unless `--force`.
4. ingest -> analyze every new clip -> compute an action score per clip (audio energy, hit density, motion) -> keep the top `--top N` (default: all) or `--limit N` files.
5. plan (hooks + captions) -> render (`--variants`) -> validate -> export only passing renders.
6. Print a summary table: clip, chosen window, estimated hits, score, variants rendered, pass/fail with reasons, output path. Nothing is ever uploaded.

## Campaign profile (YAML, validated with zod)

Fields (all with sensible defaults except `name`):

```yaml
name: cnpl
niche: sports-highlights
sources:
  localDir: ./sources/cnpl
  # optional shell template run by `clipper fetch`; {localDir} is substituted. Examples:
  # fetch: "rclone copy gdrive:CNPL/Match-footage {localDir}"
  # fetch: "gdown --folder https://drive.google.com/drive/folders/XXXX -O {localDir}"
models: {}          # optional per-campaign overrides of the task-to-model map, e.g. { plan: "<model id>" }
output:
  aspect: "9:16"
  width: 1080
  height: 1920
  fps: 30
  minSeconds: 8
  maxSeconds: 60
  targetSeconds: [12, 25]
  audio: keep            # keep | mute. Never bake in music (in-app sounds only).
  loudnessLUFS: -14
reframe:
  mode: auto             # auto | center | motion | none
  allowBlurFill: false   # blurred-background fill and letterboxing are NEVER used unless true
watermark:
  file: assets/cnpl_icon.png
  position: bottom-left
  marginPct: { x: 4, bottom: 14 }   # keep clear of platform UI
  widthPct: 14
  opacity: 1.0
  fullDuration: true
text:
  hook: { enabled: true, maxChars: 38, topPct: 14, fontFile: null, fontSize: 84, durationSec: 2.2 }
  counter: { enabled: false, label: "SHOT", minConfidence: 0.7 }
  captions: { enabled: false }
effects:
  slowmo: { enabled: false, factor: 0.45, windowSec: 1.2 }
  zoom: { enabled: false, maxScale: 1.12 }
captions:
  requiredHashtags: ["#CNPLclips"]      # case-sensitive "exactly as written"
  requiredMentions: ["@officialcnpl"]
  extraHashtags: ["#pickleball"]
  maxHashtags: 6
  limits: { tiktok: 2000, instagram: 2000, youtubeTitle: 95, youtubeDescription: 4500 }
  forbiddenWords: []
voice:
  tone: "positive, factual, energetic"
  rules:
    - "Positive only. No mocking players, officials or injuries."
    - "No fake scores, invented stats, or misleading titles."
    - "Do not claim anything not present in the provided facts."
bans:
  aiVoiceover: true
  aiFootage: true
  bakedMusic: true
postingWindows:
  - { tz: "America/Toronto", start: "18:00", end: "21:00" }
fallbackHooks:
  - "{hits} shots. Watch the finish."
  - "Wait for the last shot."
  - "This rally has everything."
```

Ship `campaigns/cnpl/profile.yaml` with exactly the values above plus a `campaigns/cnpl/README.md` listing the CNPL brief rules this profile encodes (one hashtag exactly as written; tag @officialcnpl; vertical 9:16, 8-60 s; watermark visible for the entire clip in a bottom corner without covering the ball; no AI voiceover or footage; in-app music only; positive tone; official CNPL footage only; one account per platform; send analytics proving audience geography). Note which of these rules the tool cannot verify.

## Pipeline details

### ingest
- `ffprobe` each source: duration, resolution, fps, rotation, audio presence. Assign stable `clipId` = slug of filename + short hash.
- Write `workspace/<campaign>/<clipId>/source.json`. Symlink or reference the source; never copy huge files unless `--copy`.

### analyze
- Audio: decode mono 16 kHz f32 via ffmpeg pipe. Compute RMS per 50 ms and an onset detector (energy delta with adaptive threshold, 120 ms refractory period). Output `hits[]` (time, strength) plus an overall `hitConfidence` (0-1; low when the signal is noisy or onsets are irregular). Hits are ESTIMATES: label them as such everywhere.
- Motion: decode 8 fps, 160x90 gray via ffmpeg pipe. Per-frame difference, motion energy, and motion centroid x/y (weighted). Store downsampled arrays.
- Scene cuts: ffmpeg `select='gt(scene,0.3)'` + `showinfo`, parse timestamps.
- Window selection (pure function, unit-tested): pick the best `[start,end]` within `[minSeconds, maxSeconds]` and preferring `targetSeconds`, scoring audio peaks and motion; avoid cutting inside a scene mid-action; for sources already inside bounds, only trim dead lead-in (start about 0.3 s before the first hit/motion burst) and dead tail (end about 0.8 s after the last). `--no-trim` disables trimming.
- `--vision`: extract 3-4 evenly spaced frames, downscale to max 512 px, send to the Mistral model configured for the `vision` task with the instruction to describe the visible action neutrally and NOT identify any person. Cache the result. Fail gracefully if unavailable.
- Print an `analyze` summary table: duration, chosen window, estimated hits, confidence, scene cuts, dominant motion side.

### transcribe / moments (long-form)
- `transcribe`: extract audio (16 kHz mono, compressed to fit upload limits, chunk long files with overlap and re-stitch timestamps), then transcribe with a `TranscriptionProvider`. Default provider `mistral`: multipart POST to `https://api.mistral.ai/v1/audio/transcriptions` with `model` from config, `timestamp_granularities=segment`, which returns segments with start/end times. Do not pass `language` together with `timestamp_granularities` (the docs say they are incompatible). A second provider `whisper-cmd` (env `WHISPER_CMD` template with `{wav}` and `{out}`) is optional and off by default. Output: `segments[{start,end,text}]`.
- `moments`: chunk the transcript (about 6000 tokens per chunk, overlapping), ask the LLM for candidate moments as JSON `{start,end,why,hookIdea,score}` with durations inside profile bounds, merge across chunks, snap boundaries to segment ends, rank, keep top N (`--top`, default 10). Each moment becomes a child clip (`<clipId>-m01`...) that flows through plan/render. Test with a fixture transcript and mocked HTTP.

### plan (LLM)
- Input to the LLM is a "facts" object: clip duration, chosen window, estimated hit count (with confidence), rally length, peak time, optional frame description, optional transcript excerpt, `--context` text, and the profile's niche, tone and rules. Text only. Never send video or audio.
- Output JSON (zod-validated, one auto-repair retry): `{ hooks: string[5], captions: { tiktok, instagram, youtubeTitle, youtubeDescription } }`.
- Post-processing (pure functions, unit-tested):
  - Enforce required hashtags/mentions exactly as written; add them if missing.
  - Cap hashtags at `maxHashtags`; enforce per-platform length limits.
  - Strip forbidden words.
  - Hooks longer than `maxChars` are dropped; digits in a hook are allowed only if that number exists in the facts (grounding check against fake stats).
  - Hook variants should differ in style: curiosity, stakes, count-based, direct instruction.
- `--no-llm` (or LLM failure after retries) falls back to `fallbackHooks` templates filled from the facts and template captions. The pipeline must never block on the LLM.
- Save to `copy.json`.

### render
- Build one ffmpeg command per variant: trim, reframe, scale to output size, optional zoom, burn ASS (hook, optional counter, optional captions), overlay watermark, audio loudnorm, encode (h264, yuv420p, `-movflags +faststart`, AAC 192k; NVENC `-cq 19` or x264 `-crf 18`).
- Reframe: if the source aspect is wider than about 1.2, crop a 9:16 window (`height * 9/16` wide) following the smoothed motion centroid x: EMA smoothing, deadzone, max pan speed. Implement it as a generated ffmpeg expression or `sendcmd` crop commands, your choice, but the pan must be smooth and tested. If the source is already about 9:16, just scale. If `reframe.mode` is `center`, center crop. Never letterbox and never blur-fill unless `allowBlurFill: true`.
- Counter (`--counter` or profile): "SHOT 1, 2, 3..." ticking on estimated hits inside the trimmed window; only when `hitConfidence >= minConfidence`, else skip and warn. Default OFF, because hits are estimates.
- Slow-mo (`--slowmo`): speed ramp around the strongest peak using trim/setpts segments, with audio via chained `atempo` (stay within 0.5-2.0 per filter). Zoom (`--zoom`): gentle punch-in centered on the motion centroid around peaks, capped at `maxScale`.
- Safe zones: hook text sits at `topPct` from the top, below the top platform UI band; captions and watermark stay above the bottom UI band per profile margins.
- Font: `fontFile` from profile, else resolve a bold sans via fontconfig (`fc-match`), else fail with a helpful message.
- Variants: `--variants N` renders N variants (different hook text, and alternating a "clean" and a "punchy" preset), saved as `render_v1.mp4`, `render_v2.mp4`, each with a `render_vN.json` manifest recording every parameter used.
- Render sequentially (GPU friendly). Show a progress bar from ffmpeg `-progress`.

### validate
Per render, produce `report_vN.json` and a pass/fail line:
- Duration in `[minSeconds, maxSeconds]`; resolution exactly the profile's; aspect 9:16; has audio when `audio: keep`; fps sane; file size under a configurable cap.
- Watermark: check the manifest AND verify visually by sampling 5 frames and comparing the watermark ROI against the scaled watermark (template or pixel-difference check, with a documented threshold). If the visual check proves too flaky, downgrade to manifest-only with a warning, never a silent pass.
- Black bars: detect with ffmpeg `cropdetect` and fail if bars exceed a small threshold.
- Copy: required hashtags and mentions present exactly as written, per-platform limits, forbidden words.
- `export` copies only passing renders.

### export
- `out/<campaign>/<YYYY-MM-DD>/<clipId>_vN.mp4` plus `captions.md` with, per clip and platform, a copy-paste block, and a checklist: upload natively (do not re-upload a downloaded platform copy), add in-app sound only, do not post the same clip to more accounts per platform than allowed, and send analytics proving audience geography. Also print the local-time equivalents of `postingWindows`.

### log / report
- Append rows to `workspace/<campaign>/ledger.csv`: clipId, platform, postedAt, url, views, payoutUsd, minutesSpent. `report` prints totals per campaign and platform, and effective $/hour.

## Mistral layer (`src/llm/`)

All AI goes through my Mistral API key. No local models. Never hardcode model names: Mistral renames and replaces models often, so every task has a configurable model.

- `MISTRAL_API_KEY` from `.env`. Never log it.
- Model map, resolved in this order: CLI flag `--model-<task> <id>` > campaign `profile.models.<task>` > env `MISTRAL_MODEL_<TASK>` > `MISTRAL_MODEL` > built-in default. Tasks: `plan` (hooks/captions), `moments` (long-form ranking), `draft` (profile from brief), `vision` (frame description), `transcribe` (speech to text). Built-in defaults are only starting points: `mistral-small-latest` for plan/moments/draft, and leave `vision` and `transcribe` defaults overridable via env; `doctor` must verify each configured id exists in `GET /v1/models` (for vision, check the model reports image input capability if the response exposes it) and print a clear fix if not.
- `clipper models` prints available models with their capabilities as returned by the API, plus the current task-to-model map.
- Providers: `LLMProvider` interface (`json(task, prompt, schema, opts)`, `vision(...)`) and `TranscriptionProvider`; the Mistral implementations use plain `fetch`.
  - Chat: POST `https://api.mistral.ai/v1/chat/completions`, Bearer auth, `response_format: { type: "json_object" }`, temperature about 0.7 for hooks and about 0.2 for extraction tasks.
  - Vision: same endpoint with image content parts (base64 data URLs), small frames only.
  - Transcription: see the transcribe section.
- Rate-limit resilience (limits depend on my plan and can change): concurrency 1, minimum interval between calls `MISTRAL_MIN_INTERVAL_MS` (default 1100), on 429/5xx exponential backoff with jitter honoring `retry-after`, max 6 attempts, then fall back to `--no-llm` behavior. Disk cache `.cache/llm/<sha256(model+task+prompt)>.json` so reruns cost nothing. Log approximate token usage per run and per task.
- Privacy: send only text or frames derived from the footage and the brief text, nothing else. If I am on a plan where requests may be used for training, that is my call; do not add anything sensitive.

## Repo layout

```
src/
  cli.ts
  commands/        # one file per command
  core/            # profile.ts, workspace.ts, ffmpeg.ts, probe.ts, encoder.ts
  analysis/        # audio.ts, motion.ts, scenes.ts, window.ts, vision.ts
  llm/             # provider.ts, mistral.ts, cache.ts, prompts.ts
  copy/            # plan.ts, enforce.ts, grounding.ts, fallback.ts
  render/          # reframe.ts, ass.ts, filtergraph.ts, render.ts
  validate/        # checks.ts, watermark.ts
  ledger/          # csv.ts, report.ts
campaigns/cnpl/    # profile.yaml, README.md, assets/ (I will drop cnpl_icon.png here)
scripts/           # make-sample.sh, e2e.sh
test/
README.md
.env.example
```

## Tests and acceptance

- Unit tests (vitest) for: profile parsing (including `campaigns/cnpl/profile.yaml`), window selection on synthetic energy arrays, onset detection on a synthetic signal, ASS generation, hashtag/mention enforcement, grounding check (fake digits rejected), hook length limits, pan smoothing, ledger report math, and the LLM provider (mocked fetch: 429 retry, JSON repair, cache hit).
- `scripts/make-sample.sh`: use ffmpeg lavfi to generate a 1920x1080, 10 s horizontal source with a moving box and sine beeps at known times, plus a vertical 1080x1920 source, plus a placeholder watermark PNG.
- `scripts/e2e.sh`: run `clipper run` on both samples with `--no-llm`, then assert the outputs are 1080x1920, within duration bounds, watermark present, and `validate` passes. Also run a deliberately broken render (wrong tags) and assert `validate` fails.
- README: install, `.env` setup including per-task model variables, quickstart with the CNPL flow (`clipper use cnpl && clipper run --fetch`), command reference, the "Decisions" section, and the list of rules the tool cannot verify (audience geography, account age, one account per platform, uniqueness versus other clippers).

Deliver complete, working code. Do not leave TODO stubs for anything listed above; if a part truly cannot work in this environment, implement it behind a clear error message and say so in the README.
