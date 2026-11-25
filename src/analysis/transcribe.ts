import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { runFfmpeg } from "../core/ffmpeg.js";
import type {
  TranscriptSegment,
  TranscriptionProvider,
} from "../llm/provider.js";

export class WhisperCmdTranscriptionProvider implements TranscriptionProvider {
  constructor(private readonly cmdTemplate: string) {}

  async transcribe(audioPath: string): Promise<TranscriptSegment[]> {
    const outBase = path.join(
      os.tmpdir(),
      `whisper-out-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    );
    const cmd = this.cmdTemplate
      .replaceAll("{wav}", audioPath)
      .replaceAll("{out}", outBase);

    await execa("sh", ["-c", cmd]);

    const jsonPath = fs.existsSync(`${outBase}.json`)
      ? `${outBase}.json`
      : outBase;
    const raw = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as {
      segments?: Array<{ start?: number; end?: number; text?: string }>;
      transcription?: Array<{
        offsets?: { from?: number; to?: number };
        text?: string;
      }>;
    };

    if (Array.isArray(raw.segments)) {
      return raw.segments.map((s) => ({
        start: Number(s.start ?? 0),
        end: Number(s.end ?? 0),
        text: String(s.text ?? "").trim(),
      }));
    }
    if (Array.isArray(raw.transcription)) {
      return raw.transcription.map((t) => ({
        start: Number(t.offsets?.from ?? 0) / 1000,
        end: Number(t.offsets?.to ?? 0) / 1000,
        text: String(t.text ?? "").trim(),
      }));
    }
    return [];
  }
}

export async function transcribeVideo(
  videoPath: string,
  durationSec: number,
  provider: TranscriptionProvider,
): Promise<TranscriptSegment[]> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clipper-stt-"));
  const chunkSec = 600; // 10 min chunks
  const overlapSec = 5;

  try {
    if (durationSec <= chunkSec) {
      const audioPath = path.join(tmpDir, "audio.mp3");
      await runFfmpeg([
        "-y",
        "-i",
        videoPath,
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-b:a",
        "48k",
        audioPath,
      ]);
      return await provider.transcribe(audioPath);
    }

    const allSegments: TranscriptSegment[] = [];
    let offset = 0;
    let idx = 0;
    while (offset < durationSec) {
      const chunkPath = path.join(tmpDir, `chunk_${idx}.mp3`);
      const len = Math.min(chunkSec, durationSec - offset);
      await runFfmpeg([
        "-y",
        "-ss",
        offset.toFixed(2),
        "-t",
        len.toFixed(2),
        "-i",
        videoPath,
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-b:a",
        "48k",
        chunkPath,
      ]);
      const segs = await provider.transcribe(chunkPath);
      for (const s of segs) {
        const shiftedStart = Number((s.start + offset).toFixed(2));
        const shiftedEnd = Number((s.end + offset).toFixed(2));
        // Deduplicate overlap region
        const last = allSegments[allSegments.length - 1];
        if (last && shiftedStart < last.end - 0.5) continue;
        allSegments.push({
          start: shiftedStart,
          end: shiftedEnd,
          text: s.text,
        });
      }
      if (offset + chunkSec >= durationSec) break;
      offset += chunkSec - overlapSec;
      idx++;
    }

    return allSegments;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

