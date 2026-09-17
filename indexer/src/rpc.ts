/**
 * Raw JSON-RPC access with Arc-aware throttling.
 *
 * Two reasons this exists instead of using viem's `getLogs` directly:
 *
 *  1. viem's `getLogs` builds topic filters from an ABI `event`. It silently
 *     drops a raw `topics` array — the request goes out with `"topics":[]` and
 *     you get every log from the address rather than the one event you asked
 *     for. That is a correctness bug that looks like a performance problem.
 *
 *  2. Arc's public RPC enforces an UNDOCUMENTED rate limit, returning -32005
 *     "rate limit exceeded". Nothing in the docs mentions it; we found it by
 *     hitting it. A backfill that ignores it dies partway through.
 */
import { MAX_LOG_RESULTS } from '@fineness/shared';

export interface RpcOptions {
  url: string;
  /** Minimum gap between requests. Tuned against Arc's public endpoint. */
  minIntervalMs?: number;
  maxRetries?: number;
}

export class ArcRpc {
  private readonly url: string;
  private readonly minIntervalMs: number;
  private readonly maxRetries: number;
  private lastRequestAt = 0;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(opts: RpcOptions) {
    this.url = opts.url;
    this.minIntervalMs = opts.minIntervalMs ?? 120;
    this.maxRetries = opts.maxRetries ?? 6;
  }

  /** Serialised so concurrent callers cannot collectively breach the limit. */
  async call<T>(method: string, params: unknown[]): Promise<T> {
    const run = async (): Promise<T> => {
      for (let attempt = 0; ; attempt++) {
        await this.throttle();
        const res = await fetch(this.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        });
        const body = (await res.json()) as {
          result?: T;
          error?: { code: number; message: string };
        };

        if (!body.error) return body.result as T;

        // -32005 is the rate limit. Back off and retry; it is transient.
        if (body.error.code === -32005 && attempt < this.maxRetries) {
          await sleep(500 * 2 ** attempt);
          continue;
        }

        const err = new Error(body.error.message) as Error & { code: number };
        err.code = body.error.code;
        throw err;
      }
    };

    const chained = this.queue.then(run, run);
    this.queue = chained.catch(() => undefined);
    return chained;
  }

  private async throttle(): Promise<void> {
    const wait = this.lastRequestAt + this.minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastRequestAt = Date.now();
  }

  async blockNumber(): Promise<bigint> {
    return BigInt(await this.call<string>('eth_blockNumber', []));
  }

  async getLogs(params: {
    address?: string;
    topics?: (string | null)[];
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<RawLog[]> {
    return this.call<RawLog[]>('eth_getLogs', [
      {
        ...(params.address ? { address: params.address } : {}),
        ...(params.topics ? { topics: params.topics } : {}),
        fromBlock: `0x${params.fromBlock.toString(16)}`,
        toBlock: `0x${params.toBlock.toString(16)}`,
      },
    ]);
  }
}

export interface RawLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
  logIndex: string;
}

export const LOG_RESULT_CAP = MAX_LOG_RESULTS;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
