import fs from "node:fs";
import path from "node:path";
import { ensureDir, getCampaignWorkspaceDir } from "../core/workspace.js";

export interface LedgerRow {
  clipId: string;
  platform: string;
  postedAt: string;
  url: string;
  views: number;
  payoutUsd: number;
  minutesSpent: number;
}

const CSV_HEADER =
  "clipId,platform,postedAt,url,views,payoutUsd,minutesSpent\n";

function escapeCsvField(val: string | number): string {
  const s = String(val);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

export function getLedgerPath(workspaceDir: string, campaign: string): string {
  return path.join(getCampaignWorkspaceDir(workspaceDir, campaign), "ledger.csv");
}

export function appendLedgerRow(
  workspaceDir: string,
  campaign: string,
  row: LedgerRow,
): string {
  const ledgerPath = getLedgerPath(workspaceDir, campaign);
  ensureDir(path.dirname(ledgerPath));
  if (!fs.existsSync(ledgerPath)) {
    fs.writeFileSync(ledgerPath, CSV_HEADER, "utf8");
  }
  const line =
    [
      row.clipId,
      row.platform,
      row.postedAt,
      row.url,
      row.views,
      row.payoutUsd.toFixed(2),
      row.minutesSpent,
    ]
      .map(escapeCsvField)
      .join(",") + "\n";
  fs.appendFileSync(ledgerPath, line, "utf8");
  return ledgerPath;
}

export function readLedgerRows(
  workspaceDir: string,
  campaign: string,
): LedgerRow[] {
  const ledgerPath = getLedgerPath(workspaceDir, campaign);
  if (!fs.existsSync(ledgerPath)) return [];
  const raw = fs.readFileSync(ledgerPath, "utf8").trim();
  if (!raw) return [];
  const lines = raw.split(/\r?\n/);
  const rows: LedgerRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = parseCsvLine(line);
    if (cols.length < 7) continue;
    rows.push({
      clipId: cols[0],
      platform: cols[1],
      postedAt: cols[2],
      url: cols[3],
      views: Number(cols[4]) || 0,
      payoutUsd: Number(cols[5]) || 0,
      minutesSpent: Number(cols[6]) || 0,
    });
  }
  return rows;
}

