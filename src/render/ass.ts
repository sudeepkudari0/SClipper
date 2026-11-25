import type { EstimatedHit } from "../analysis/audio.js";
import type { CampaignProfile } from "../core/profile.js";

function formatAssTime(sec: number): string {
  const clamped = Math.max(0, sec);
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  const s = Math.floor(clamped % 60);
  const cs = Math.floor((clamped - Math.floor(clamped)) * 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

function escapeAssText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\{/g, "\\{").replace(/\}/g, "\\}");
}

function cleanAndWrapHook(text: string, maxCharsPerLine = 24): string {
  const cleaned = text.replace(/[*_`]/g, "").replace(/\s+/g, " ").trim();
  const words = cleaned.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const w of words) {
    if (!current) {
      current = w;
    } else if (current.length + 1 + w.length <= maxCharsPerLine) {
      current += " " + w;
    } else {
      lines.push(current);
      current = w;
    }
  }
  if (current) lines.push(current);
  // Keep the second line visually dominant without requiring a second render
  // pass. This is especially effective for short hooks such as "WAIT FOR / THE
  // FINISH" and remains readable on busy footage because both lines share the
  // same outline and shadow.
  return lines
    .map((line, index) => {
      const escaped = escapeAssText(line);
      return index === 1 ? `{\\c&H004DD9FF&}${escaped}{\\c}` : escaped;
    })
    .join("\\N");
}

export interface AssBuildOptions {
  width: number;
  height: number;
  durationSec: number;
  fontName: string;
  hookText?: string;
  profile: CampaignProfile;
  preset: "clean" | "punchy";
  hits?: EstimatedHit[];
  hitConfidence?: number;
  windowStartSec?: number;
  enableCounter?: boolean;
}

export function generateAssContent(opts: AssBuildOptions): string {
  const {
    width,
    height,
    durationSec,
    fontName,
    hookText,
    profile,
    preset,
    hits = [],
    hitConfidence = 0,
    windowStartSec = 0,
    enableCounter = false,
  } = opts;

  const hookCfg = profile.text.hook;
  const counterCfg = profile.text.counter;

  const topMarginV = Math.round((hookCfg.topPct / 100) * height);
  const fontSize = preset === "punchy" ? hookCfg.fontSize + 8 : hookCfg.fontSize;
  const outline = preset === "punchy" ? 7 : 6;
  const shadow = preset === "punchy" ? 3 : 2;
  const primaryColor = preset === "punchy" ? "&H00FFF8E8" : "&H00FFFFFF";
  const borderStyle = preset === "punchy" ? 3 : 1;
  const backColour = preset === "punchy" ? "&H990C0C0C" : "&H90000000";

  const lines: string[] = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Hook,${fontName},${fontSize},${primaryColor},&H000000FF,&H00121212,${backColour},-1,0,0,0,100,100,0.2,0,${borderStyle},${outline},${shadow},8,90,90,${topMarginV},1`,
    `Style: Counter,${fontName},${Math.round(fontSize * 0.68)},&H00FFFFFF,&H000000FF,&H00121212,&H99000000,-1,0,0,0,100,100,0.2,0,1,5,2,9,90,90,${topMarginV},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];

  if (hookCfg.enabled && hookText && hookText.trim().length > 0) {
    const endHook = Math.min(durationSec, hookCfg.durationSec);
    lines.push(
      `Dialogue: 0,${formatAssTime(0)},${formatAssTime(endHook)},Hook,,0,0,0,,{\\fad(100,100)}${cleanAndWrapHook(hookText, preset === "punchy" ? 22 : 24)}`,
    );
  }

  if (enableCounter && hitConfidence >= counterCfg.minConfidence) {
    const windowHits = hits.filter(
      (h) =>
        h.time >= windowStartSec &&
        h.time <= windowStartSec + durationSec,
    );
    for (let i = 0; i < windowHits.length; i++) {
      const tStart = Math.max(0, windowHits[i].time - windowStartSec);
      const tEnd =
        i + 1 < windowHits.length
          ? Math.max(tStart + 0.15, windowHits[i + 1].time - windowStartSec)
          : durationSec;
      lines.push(
        `Dialogue: 1,${formatAssTime(tStart)},${formatAssTime(tEnd)},Counter,,0,0,0,,${escapeAssText(`${counterCfg.label} ${i + 1}`)}`,
      );
    }
  }

  return lines.join("\n") + "\n";
}

