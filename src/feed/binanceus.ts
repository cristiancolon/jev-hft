// Binance.US public market data for one symbol: the order book, rebuilt from a snapshot and the
// 100 ms diff stream, and every trade. No API key. Events come out in the standard form
// (src/feed/types.ts), so a recording replays through the same market state as Coinbase's.
// https://docs.binance.us/ (WebSocket market streams; managing a local order book)
//
// Why record it at all: Binance.US charges nothing for resting orders, and its market makers most
// likely price off the large exchanges that refuse connections from the US, so its quotes may say
// something Coinbase's do not (docs/decisions.md D58). It trades very little: about 4,000 BTC/USD
// trades a day in September 2026, so its book matters more than its trades.
//
// How the book is kept right, following Binance's own procedure:
// 1. Open the stream and hold on to the diffs.
// 2. Fetch a snapshot over REST. Diffs the snapshot already includes (u <= lastUpdateId) are dropped.
// 3. The first diff applied must reach across the snapshot (U <= lastUpdateId + 1 <= u); after that
//    each diff must start exactly where the last one ended (U = previous u + 1). Anything else
//    means an update was missed, and the book is rebuilt from scratch.
//
// The snapshot carries no time, so the rebuilt book is stamped with the moment the snapshot
// arrived: that is when the book became known (docs/decisions.md D3). Diffs held while waiting
// for it get that same arrival time, keeping every recording in time order.
//
// On a trade, `m` says whether the buyer's order was the one resting on the book, so the side
// that made the trade happen is the seller when it is true.

import { nowMs, type Feed, type LevelUpdate, type MarketEvent } from './types.ts';

const STREAM_URL = 'wss://stream.binance.us:9443/stream?streams=';
const DEPTH_URL = 'https://api.binance.us/api/v3/depth';
/** The most the snapshot can hold. BTC/USD's whole book was about 600 levels a side. */
const SNAPSHOT_LEVELS = 5000;
/**
 * Book updates came every 190 ms at the median and never more than 2.1 s apart over 90 s from the
 * Pi, so this much silence means the connection is dead. The server's pings, every 20 s, are
 * answered by Node on its own and never reach this code.
 */
const STALL_MS = 30_000;
/** Diffs held while waiting for the snapshot; far more than a working fetch ever needs. */
const MAX_HELD = 2_000;

type Level = [price: string, quantity: string];
export type DepthDiff = { e: 'depthUpdate'; E: number; U: number; u: number; b: Level[]; a: Level[] };
export type DepthSnapshot = { lastUpdateId: number; bids: Level[]; asks: Level[] };
export type Trade = { e: 'trade'; p: string; q: string; T: number; m: boolean };

const levels = (side: 'bid' | 'ask', xs: Level[]): LevelUpdate[] => xs.map(([p, q]) => ({ side, price: Number(p), size: Number(q) }));

/**
 * Rebuilds the book from the snapshot and the diff stream, and says when that is no longer
 * possible. It never touches the network, so every rule above can be tested directly.
 */
export class DepthSync {
  private held: { d: DepthDiff; recvTs: number }[] = [];
  /** The last update folded into the book. NaN until the snapshot has arrived. */
  private lastU = NaN;
  /** The first diff after the snapshot may reach across it; every later one must follow on exactly. */
  private straddle = false;
  private readonly emit: (e: MarketEvent) => void;

  constructor(emit: (e: MarketEvent) => void) {
    this.emit = emit;
  }

  get synced() {
    return !Number.isNaN(this.lastU);
  }

  get heldCount() {
    return this.held.length;
  }

  /** A diff from the stream. False when one was missed and the book has to be rebuilt. */
  diff(d: DepthDiff, recvTs: number): boolean {
    if (!this.synced) {
      this.held.push({ d, recvTs });
      return true;
    }
    return this.accept(d, recvTs);
  }

  /**
   * The REST snapshot. 'early' when it is older than every diff held (the diffs in between were
   * never seen, so fetch again); 'gap' when the held diffs do not join up; 'ok' once the book is
   * rebuilt and every held diff applied.
   */
  snapshot(s: DepthSnapshot, recvTs: number): 'ok' | 'early' | 'gap' {
    const first = this.held[0];
    if (first && first.d.U > s.lastUpdateId + 1) return 'early';
    this.emit({ type: 'book', snapshot: true, updates: [...levels('bid', s.bids), ...levels('ask', s.asks)], exchTs: recvTs, recvTs });
    this.lastU = s.lastUpdateId;
    this.straddle = true;
    const held = this.held;
    this.held = [];
    for (const h of held) if (!this.accept(h.d, recvTs)) return 'gap';
    return 'ok';
  }

  private accept(d: DepthDiff, recvTs: number): boolean {
    if (this.straddle) {
      if (d.u <= this.lastU) return true; // already in the snapshot
      if (d.U > this.lastU + 1) return false; // something between the snapshot and this diff was missed
      this.straddle = false;
    } else if (d.U !== this.lastU + 1) {
      return false;
    }
    this.lastU = d.u;
    const updates = [...levels('bid', d.b), ...levels('ask', d.a)];
    if (updates.length > 0) this.emit({ type: 'book', snapshot: false, updates, exchTs: d.E, recvTs });
    return true;
  }
}

export function tradeEvent(t: Trade, recvTs: number): MarketEvent {
  return { type: 'trade', price: Number(t.p), size: Number(t.q), aggressor: t.m ? 'sell' : 'buy', exchTs: t.T, recvTs };
}

export function binanceUsFeed(symbol: string, onEvent: (e: MarketEvent) => void, log = console.error): Feed {
  const tag = `[binanceus:${symbol}]`;
  let ws: WebSocket | undefined;
  let closed = false;
  let lastMessageTs = nowMs();
  let backoffMs = 500;
  let reconnectTimer: NodeJS.Timeout | undefined;

  /** Drop the current connection (whatever state it is in) and open a new one after a pause. */
  const reconnect = (why: string) => {
    const old = ws;
    ws = undefined; // late messages and snapshots for the old socket are ignored
    old?.close();
    if (closed) return;
    onEvent({ type: 'reset', recvTs: nowMs() });
    log(`${tag} ${why}, reconnecting in ${backoffMs}ms`);
    reconnectTimer = setTimeout(connect, backoffMs);
    backoffMs = Math.min(backoffMs * 2, 10_000);
  };

  const fetchSnapshot = async (socket: WebSocket, sync: DepthSync, attempt = 1): Promise<void> => {
    try {
      const res = await fetch(`${DEPTH_URL}?symbol=${symbol}&limit=${SNAPSHOT_LEVELS}`, { signal: AbortSignal.timeout(10_000) });
      if (socket !== ws) return;
      if (!res.ok) return reconnect(`snapshot refused (HTTP ${res.status})`);
      const snap = (await res.json()) as DepthSnapshot;
      if (socket !== ws) return;
      const result = sync.snapshot(snap, nowMs());
      if (result === 'early') {
        if (attempt >= 5) return reconnect('the snapshot kept arriving older than the stream');
        setTimeout(() => void fetchSnapshot(socket, sync, attempt + 1), 250 * attempt);
        return;
      }
      if (result === 'gap') return reconnect('the stream skipped an update while the book was being rebuilt');
      backoffMs = 500; // data is flowing again
    } catch (error) {
      if (socket === ws) reconnect(`snapshot failed: ${(error as Error).message}`);
    }
  };

  const connect = () => {
    lastMessageTs = nowMs();
    const lower = symbol.toLowerCase();
    const socket = new WebSocket(`${STREAM_URL}${lower}@depth@100ms/${lower}@trade`);
    const sync = new DepthSync(onEvent);
    let asked = false;
    ws = socket;
    socket.onmessage = ev => {
      if (socket !== ws) return;
      const recvTs = nowMs();
      lastMessageTs = recvTs;
      const data = (JSON.parse(String(ev.data)) as { data?: DepthDiff | Trade }).data;
      if (data?.e === 'depthUpdate') {
        if (!sync.diff(data, recvTs)) return reconnect(`update ${data.U} does not follow on from the last one`);
        // Asked for only once a diff is being held, so the snapshot is sure to join up with the stream.
        if (!asked) {
          asked = true;
          void fetchSnapshot(socket, sync);
        }
        if (sync.heldCount > MAX_HELD) return reconnect('the snapshot is taking too long');
      } else if (data?.e === 'trade') {
        onEvent(tradeEvent(data, recvTs));
      }
    };
    socket.onerror = () => {}; // onclose follows and handles reconnect
    socket.onclose = () => {
      if (socket === ws) reconnect('disconnected');
    };
  };

  const watchdog = setInterval(() => {
    if (ws && nowMs() - lastMessageTs > STALL_MS) reconnect(`no messages for ${STALL_MS / 1000}s`);
  }, STALL_MS / 2);

  connect();
  return {
    close() {
      closed = true;
      clearInterval(watchdog);
      clearTimeout(reconnectTimer);
      ws?.close();
    },
  };
}
