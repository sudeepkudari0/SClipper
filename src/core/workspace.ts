import fs from "node:fs";
import path from "node:path";

export function ensureDir(dirPath: string): string {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

export function readJson<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw) as T;
}

export function writeJson(filePath: string, data: unknown): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

export function getActiveCampaignFile(workspaceDir: string): string {
  return path.join(workspaceDir, ".active");
}

export function getCampaignWorkspaceDir(
  workspaceDir: string,
  campaign: string,
): string {
  return path.join(workspaceDir, campaign);
}

export function getClipDir(
  workspaceDir: string,
  campaign: string,
  clipId: string,
): string {
  return path.join(workspaceDir, campaign, clipId);
}

export function getLlmCacheDir(cwd = process.cwd()): string {
  return path.join(cwd, ".cache", "llm");
}

export function getEncoderCachePath(cwd = process.cwd()): string {
  return path.join(cwd, ".cache", "encoder.json");
}

export function getOutDir(
  campaign: string,
  dateStr = new Date().toISOString().slice(0, 10),
  cwd = process.cwd(),
): string {
  return path.join(cwd, "out", campaign, dateStr);
}

export function listClipIds(workspaceDir: string, campaign: string): string[] {
  const dir = getCampaignWorkspaceDir(workspaceDir, campaign);
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries
    .filter(
      (e) =>
        e.isDirectory() &&
        fs.existsSync(path.join(dir, e.name, "source.json")),
    )
    .map((e) => e.name)
    .sort();
}

