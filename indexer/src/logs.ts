/**
 * Chunked log fetching for Arc.
 *
 * Arc's RPC caps `eth_getLogs` at 2000 results. A single wide range ALWAYS
 * fails, so every historical scan has to page. Three details make this less
 * obvious than it looks:
 *
 *  1. The `-32602` error body carries a suggested narrower range. Following it
 *     beats guessing a chunk size, because activity varies enormously by block.
 *
 *  2. That suggestion is computed against the node's head AT ERROR TIME. Reusing
 *     one later can produce a `fromBlock` past current head, which comes back
 *     `-32014 requested data not available` — indistinguishable at a glance from
 *     pruned history, and it is not that. Deep history works fine; ranges 1M
 *     blocks back retrieve normally. So every suggestion is clamped to a fresh
 *     head before use.
 *
 *  3. There is also an undocumented request rate limit (-32005), handled a layer
 *     down in ArcRpc.
 *
 * All three were found by hitting them. See ARC-FINDINGS.md.
 */
import type { ArcRpc, RawLog } from './rpc.js';

/** Parses "retry with the range 21363653-21363951" out of an RPC error. */
export function parseRangeHint(message: string): { from: bigint; to: bigint } | null {
  const m = message.match(/range\s+(\d+)\s*-\s*(\d+)/i);
  if (!m || !m[1] || !m[2]) return null;
  return { from: BigInt(m[1]), to: BigInt(m[2]) };
}

export function isRangeTooWide(err: unknown): boolean {
  const msg = errorMessage(err);
  return msg.includes('max results') || msg.includes('exceeded max allowed range');
}

export function errorMessage(err: unknown): string {
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object') return JSON.stringify(err);
  return String(err);
}

export interface ScanOptions {
  address?: string;
  topics?: (string | null)[];
  fromBlock: bigint;
  toBlock: bigint;
  onLogs?: (logs: RawLog[]) => void | Promise<void>;
  onProgress?: (fromBlock: bigint, toBlock: bigint, found: number) => void;
}

/**
 * Scan a block range, adapting chunk size to whatever the node will serve.
 *
 * Grows the window on a quiet stretch and shrinks it on rejection, so a sparse
 * range crosses in few calls while a busy one degrades instead of failing.
 */
export async function scanLogs(rpc: ArcRpc, opts: ScanOptions): Promise<RawLog[]> {
  const collected: RawLog[] = [];
  let cursor = opts.fromBlock;
  let chunk = 40n;

  while (cursor <= opts.toBlock) {
    const to = min(cursor + chunk - 1n, opts.toBlock);

    try {
      const logs = await rpc.getLogs({
        ...(opts.address ? { address: opts.address } : {}),
        ...(opts.topics ? { topics: opts.topics } : {}),
        fromBlock: cursor,
        toBlock: to,
      });

      collected.push(...logs);
      if (opts.onLogs) await opts.onLogs(logs);
      opts.onProgress?.(cursor, to, collected.length);

      cursor = to + 1n;
      if (logs.length < 500) chunk *= 2n;
    } catch (err) {
      if (!isRangeTooWide(err)) throw err;

      const hint = parseRangeHint(errorMessage(err));
      if (hint) {
        // Clamp against a fresh head. An unclamped hint can point past the tip
        // and return -32014, which looks like missing history and is not.
        const head = await rpc.blockNumber();
        const hintedTo = min(hint.to, head);
        if (hintedTo >= cursor) {
          chunk = maxBig(1n, hintedTo - cursor + 1n);
          continue;
        }
      }

      chunk = maxBig(1n, chunk / 4n);
      if (chunk === 1n) {
        throw new Error(
          `Block ${cursor} alone exceeds the log result cap: ${errorMessage(err)}`,
        );
      }
    }
  }

  return collected;
}

const min = (a: bigint, b: bigint) => (a < b ? a : b);
const maxBig = (a: bigint, b: bigint) => (a > b ? a : b);
