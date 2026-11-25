import type { LedgerRow } from "./csv.js";

export interface PlatformTotals {
  platform: string;
  posts: number;
  views: number;
  payoutUsd: number;
  minutesSpent: number;
  dollarsPerHour: number;
}

export interface LedgerSummary {
  totalPosts: number;
  totalViews: number;
  totalPayoutUsd: number;
  totalMinutesSpent: number;
  dollarsPerHour: number;
  byPlatform: PlatformTotals[];
}

export function computeLedgerSummary(rows: LedgerRow[]): LedgerSummary {
  const map = new Map<string, PlatformTotals>();
  let totalViews = 0;
  let totalPayoutUsd = 0;
  let totalMinutesSpent = 0;

  for (const r of rows) {
    totalViews += r.views;
    totalPayoutUsd += r.payoutUsd;
    totalMinutesSpent += r.minutesSpent;

    const key = r.platform.toLowerCase();
    const cur = map.get(key) ?? {
      platform: key,
      posts: 0,
      views: 0,
      payoutUsd: 0,
      minutesSpent: 0,
      dollarsPerHour: 0,
    };
    cur.posts += 1;
    cur.views += r.views;
    cur.payoutUsd += r.payoutUsd;
    cur.minutesSpent += r.minutesSpent;
    map.set(key, cur);
  }

  const byPlatform = [...map.values()]
    .map((p) => ({
      ...p,
      payoutUsd: Number(p.payoutUsd.toFixed(2)),
      dollarsPerHour:
        p.minutesSpent > 0
          ? Number(((p.payoutUsd / p.minutesSpent) * 60).toFixed(2))
          : 0,
    }))
    .sort((a, b) => b.payoutUsd - a.payoutUsd);

  return {
    totalPosts: rows.length,
    totalViews,
    totalPayoutUsd: Number(totalPayoutUsd.toFixed(2)),
    totalMinutesSpent,
    dollarsPerHour:
      totalMinutesSpent > 0
        ? Number(((totalPayoutUsd / totalMinutesSpent) * 60).toFixed(2))
        : 0,
    byPlatform,
  };
}

