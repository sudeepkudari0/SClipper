import { execa } from "execa";

export interface FfmpegRunOptions {
  totalDurationSec?: number;
  onProgress?: (fraction: number) => void;
}

export async function runFfmpeg(
  args: string[],
  opts: FfmpegRunOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  const fullArgs = opts.onProgress
    ? ["-progress", "pipe:1", "-nostats", ...args]
    : ["-nostats", ...args];

  const proc = execa("ffmpeg", fullArgs, {
    reject: false,
    buffer: true,
  });

  if (opts.onProgress && proc.stdout) {
    let buf = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("out_time_us=") && opts.totalDurationSec && opts.totalDurationSec > 0) {
          const us = Number(line.slice("out_time_us=".length).trim());
          if (Number.isFinite(us)) {
            const frac = Math.min(1, Math.max(0, us / (opts.totalDurationSec * 1_000_000)));
            opts.onProgress?.(frac);
          }
        } else if (line === "progress=end") {
          opts.onProgress?.(1);
        }
      }
    });
  }

  const res = await proc;
  if (res.exitCode !== 0) {
    throw new Error(
      `ffmpeg failed (exit ${res.exitCode}):\n${res.stderr.slice(-1500)}`,
    );
  }
  return { stdout: res.stdout, stderr: res.stderr };
}

export async function pipeFfmpegRaw(args: string[]): Promise<Buffer> {
  const res = await execa("ffmpeg", ["-v", "error", ...args], {
    encoding: "buffer",
    reject: false,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (res.exitCode !== 0) {
    const errText = Buffer.isBuffer(res.stderr)
      ? res.stderr.toString("utf8")
      : String(res.stderr);
    throw new Error(`ffmpeg pipe failed (exit ${res.exitCode}): ${errText}`);
  }
  return Buffer.from(res.stdout);
}
