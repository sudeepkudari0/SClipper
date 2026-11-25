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
  const outline = preset === "punchy" ? 6 : 4;
  const shadow = preset === "punchy" ? 3 : 1;
  const primaryColor = preset === "punchy" ? "&H0000E5FF" : "&H00FFFFFF"; // yellow-gold vs white

  const lines: string[] = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Hook,${fontName},${hookCfg.fontSize},${primaryColor},&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,${outline},${shadow},8,60,60,${topMarginV},1`,
    `Style: Counter,${fontName},${Math.round(hookCfg.fontSize * 0.72)},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,4,2,9,60,60,${topMarginV},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];

  if (hookCfg.enabled && hookText && hookText.trim().length > 0) {
    const endHook = Math.min(durationSec, hookCfg.durationSec);
    lines.push(
      `Dialogue: 0,${formatAssTime(0)},${formatAssTime(endHook)},Hook,,0,0,0,,${escapeAssText(hookText.trim())}`,
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

