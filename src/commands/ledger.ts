import pc from "picocolors";
import { appendLedgerRow, readLedgerRows } from "../ledger/csv.js";
import { computeLedgerSummary } from "../ledger/report.js";
import { resolveCommandContext, type GlobalOptions } from "./context.js";

export async function logCommand(
  cmdOpts: {
    clip: string;
    platform: string;
    views: number;
    payout?: number;
    minutes?: number;
    url?: string;
  },
  opts: GlobalOptions,
): Promise<void> {
  const ctx = resolveCommandContext(opts);
  const row = {
    clipId: cmdOpts.clip,
    platform: cmdOpts.platform,
    postedAt: new Date().toISOString(),
    url: cmdOpts.url ?? "",
    views: Number(cmdOpts.views) || 0,
    payoutUsd: Number(cmdOpts.payout ?? 0) || 0,
    minutesSpent: Number(cmdOpts.minutes ?? 0) || 0,
  };
  const ledgerPath = appendLedgerRow(ctx.workspaceDir, ctx.campaign, row);
  if (ctx.json) {
    console.log(JSON.stringify({ ledgerPath, row }, null, 2));
  } else {
    console.log(pc.green(`Logged ${row.clipId} (${row.platform}) to ${ledgerPath}`));
  }
}

export async function reportCommand(opts: GlobalOptions): Promise<void> {
  const ctx = resolveCommandContext(opts);
  const rows = readLedgerRows(ctx.workspaceDir, ctx.campaign);
  const summary = computeLedgerSummary(rows);

  if (ctx.json) {
    console.log(JSON.stringify({ campaign: ctx.campaign, summary }, null, 2));
    return;
  }

  console.log(
    `\nPosts: ${summary.totalPosts} | Views: ${summary.totalViews.toLocaleString()} | Payout: $${summary.totalPayoutUsd.toFixed(2)} | Time: ${summary.totalMinutesSpent}m | Effective: $${summary.dollarsPerHour.toFixed(2)}/hr`,
  );
  if (summary.byPlatform.length > 0) {
    console.log("\nPer platform:");
    for (const p of summary.byPlatform) {
      console.log(
        `  ${p.platform.padEnd(12)} posts=${p.posts} views=${p.views.toLocaleString()} payout=$${p.payoutUsd.toFixed(2)} ($${p.dollarsPerHour.toFixed(2)}/hr)`,
      );
    }
  }
}

