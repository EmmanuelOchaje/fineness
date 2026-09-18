/**
 * API client.
 *
 * Every fetch is no-store. A cached risk verdict is worse than no verdict —
 * the whole value proposition is that the answer reflects current chain state.
 */
import type { ApiReport } from './assay.js';

const BASE = process.env.FINENESS_API ?? 'http://127.0.0.1:8080';

export interface FeedRow {
  token: string;
  mark: string;
  score: number;
  isHoneypot: boolean;
  tokenTaxBps: number;
  venueFeeBps: number;
  flags: string[];
  checkedAt: number;
}

export async function getFeed(limit = 50): Promise<FeedRow[]> {
  try {
    const res = await fetch(`${BASE}/tokens?limit=${limit}`, { cache: 'no-store' });
    if (!res.ok) return [];
    const body = (await res.json()) as { tokens: FeedRow[] };
    return body.tokens ?? [];
  } catch {
    // The feed must render even when the API is down. An empty feed is a
    // designed state; a stack trace is not.
    return [];
  }
}

export async function getReport(address: string): Promise<ApiReport | null> {
  try {
    const res = await fetch(`${BASE}/tokens/${address}`, { cache: 'no-store' });
    if (!res.ok) return null;
    return (await res.json()) as ApiReport;
  } catch {
    return null;
  }
}
