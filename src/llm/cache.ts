import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getLlmCacheDir } from "../core/workspace.js";

export function makeLlmCacheKey(model: string, task: string, prompt: string): string {
  return crypto
    .createHash("sha256")
    .update(`${model}\n${task}\n${prompt}`)
    .digest("hex");
}

export function getCachedLlm<T>(
  model: string,
  task: string,
  prompt: string,
  cacheDir = getLlmCacheDir(),
): T | null {
  const key = makeLlmCacheKey(model, task, prompt);
  const file = path.join(cacheDir, `${key}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as { response: T };
    return parsed.response;
  } catch {
    return null;
  }
}

export function setCachedLlm<T>(
  model: string,
  task: string,
  prompt: string,
  response: T,
  cacheDir = getLlmCacheDir(),
): void {
  fs.mkdirSync(cacheDir, { recursive: true });
  const key = makeLlmCacheKey(model, task, prompt);
  const file = path.join(cacheDir, `${key}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        model,
        task,
        cachedAt: new Date().toISOString(),
        response,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
}

