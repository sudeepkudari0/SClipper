import { execa } from "execa";

export async function detectSceneCuts(videoPath: string): Promise<number[]> {
  const res = await execa(
    "ffmpeg",
    [
      "-i",
      videoPath,
      "-vf",
      "select='gt(scene,0.3)',showinfo",
      "-f",
      "null",
      "-",
    ],
    { reject: false },
  );

  const cuts: number[] = [];
  const regex = /pts_time:([0-9]+(?:\.[0-9]+)?)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(res.stderr)) !== null) {
    const t = Number(match[1]);
    if (Number.isFinite(t)) {
      cuts.push(Number(t.toFixed(2)));
    }
  }
  return cuts;
}

