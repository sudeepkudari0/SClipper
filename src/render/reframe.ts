export interface SmoothPanOptions {
  emaAlpha?: number;
  deadzone?: number;
  maxPanSpeedPerSec?: number;
}

/**
 * Smooth normalized centroidX values [0..1] using EMA, deadzone, and max pan speed.
 */
export function smoothMotionCentroidX(
  rawX: number[],
  fps = 8,
  opts: SmoothPanOptions = {},
): number[] {
  if (rawX.length === 0) return [];
  const alpha = opts.emaAlpha ?? 0.22;
  const deadzone = opts.deadzone ?? 0.04;
  const maxStep = (opts.maxPanSpeedPerSec ?? 0.35) / Math.max(1, fps);

  const out: number[] = new Array(rawX.length);
  let current = Math.max(0, Math.min(1, rawX[0]));
  out[0] = Number(current.toFixed(4));

  for (let i = 1; i < rawX.length; i++) {
    const target = Math.max(0, Math.min(1, rawX[i]));
    const ema = alpha * target + (1 - alpha) * current;
    const diff = ema - current;

    if (Math.abs(diff) <= deadzone) {
      out[i] = Number(current.toFixed(4));
      continue;
    }

    const clampedStep = Math.max(-maxStep, Math.min(maxStep, diff));
    current = Math.max(0, Math.min(1, current + clampedStep));
    out[i] = Number(current.toFixed(4));
  }

  return out;
}

export interface ReframeFilterResult {
  cropFilter: string;
  modeUsed: "scale_only" | "center" | "motion" | "blur_fill";
  cropWidth: number;
  cropHeight: number;
}

/**
 * Build ffmpeg crop+scale filter string for reframing source into 9:16 output.
 */
export function buildReframeFilter(opts: {
  srcWidth: number;
  srcHeight: number;
  outWidth: number;
  outHeight: number;
  mode: "auto" | "center" | "motion" | "none";
  allowBlurFill: boolean;
  centroidXPerFrame?: number[];
  motionFps?: number;
  startSec?: number;
  endSec?: number;
}): ReframeFilterResult {
  const {
    srcWidth,
    srcHeight,
    outWidth,
    outHeight,
    mode,
    allowBlurFill,
    centroidXPerFrame = [],
    motionFps = 8,
    startSec = 0,
    endSec = 10,
  } = opts;

  const srcAspect = srcWidth / Math.max(1, srcHeight);
  const targetAspect = outWidth / Math.max(1, outHeight);

  // Already ~9:16 or vertical
  if (srcAspect <= 1.2) {
    return {
      cropFilter: `scale=${outWidth}:${outHeight}:force_original_aspect_ratio=increase,crop=${outWidth}:${outHeight}`,
      modeUsed: "scale_only",
      cropWidth: srcWidth,
      cropHeight: srcHeight,
    };
  }

  if (mode === "none" && allowBlurFill) {
    return {
      cropFilter: `split[bg][fg];[bg]scale=${outWidth}:${outHeight}:force_original_aspect_ratio=increase,crop=${outWidth}:${outHeight},boxblur=20:5[bgb];[fg]scale=${outWidth}:${outHeight}:force_original_aspect_ratio=decrease[fgb];[bgb][fgb]overlay=(W-w)/2:(H-h)/2`,
      modeUsed: "blur_fill",
      cropWidth: srcWidth,
      cropHeight: srcHeight,
    };
  }

  // Compute 9:16 crop window inside horizontal source
  let cropW = Math.round(srcHeight * targetAspect);
  cropW = Math.min(srcWidth, cropW);
  if (cropW % 2 !== 0) cropW -= 1;
  const cropH = srcHeight % 2 === 0 ? srcHeight : srcHeight - 1;
  const maxOffset = Math.max(0, srcWidth - cropW);

  if (mode === "center" || mode === "none" || centroidXPerFrame.length === 0) {
    const x = Math.round(maxOffset / 2);
    return {
      cropFilter: `crop=${cropW}:${cropH}:${x}:0,scale=${outWidth}:${outHeight}`,
      modeUsed: "center",
      cropWidth: cropW,
      cropHeight: cropH,
    };
  }

  // Motion-tracked pan: slice centroids for [startSec, endSec], smooth, downsample to ~2Hz keyframes
  const startIdx = Math.max(0, Math.floor(startSec * motionFps));
  const endIdx = Math.min(
    centroidXPerFrame.length,
    Math.ceil(endSec * motionFps),
  );
  const slice =
    endIdx > startIdx
      ? centroidXPerFrame.slice(startIdx, endIdx)
      : centroidXPerFrame;
  const smoothed = smoothMotionCentroidX(slice, motionFps);

  const sampleStep = Math.max(1, Math.round(motionFps / 2)); // ~2 keyframes/sec
  const keyframes: Array<{ t: number; x: number }> = [];
  for (let i = 0; i < smoothed.length; i += sampleStep) {
    const t = Number((i / motionFps).toFixed(2));
    const cx = smoothed[i];
    const xPx = Math.round(
      Math.max(0, Math.min(maxOffset, cx * srcWidth - cropW / 2)),
    );
    keyframes.push({ t, x: xPx });
  }

  if (keyframes.length <= 1) {
    const x = keyframes[0]?.x ?? Math.round(maxOffset / 2);
    return {
      cropFilter: `crop=${cropW}:${cropH}:${x}:0,scale=${outWidth}:${outHeight}`,
      modeUsed: "motion",
      cropWidth: cropW,
      cropHeight: cropH,
    };
  }

  // Build piecewise linear interpolation expression over t
  let expr = String(keyframes[keyframes.length - 1].x);
  for (let i = keyframes.length - 2; i >= 0; i--) {
    const k0 = keyframes[i];
    const k1 = keyframes[i + 1];
    const dt = Math.max(0.01, k1.t - k0.t);
    const dx = k1.x - k0.x;
    const segExpr =
      dx === 0
        ? String(k0.x)
        : `(${k0.x}+${dx}*((t-${k0.t})/${dt.toFixed(2)}))`;
    expr = `if(lt(t,${k1.t}),${segExpr},${expr})`;
  }

  return {
    cropFilter: `crop=${cropW}:${cropH}:x='${expr}':y=0,scale=${outWidth}:${outHeight}`,
    modeUsed: "motion",
    cropWidth: cropW,
    cropHeight: cropH,
  };
}

