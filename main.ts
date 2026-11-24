// Traction Sniper v2 — pump.fun bonding-curve replay bot (agent-fun/replay/v2).
//
// Idea: most new curves are instant dumps; a few run. The bot only buys launches whose
// opening tape already proves real demand — many distinct buyers, real SOL in the curve,
// no creator sell — and it risks a small ticket first, then pyramids only while the curve
// keeps growing. Every exit is mechanical: hard stop, trailing stop after a gain, a
// reserve-drawdown exit, or a time limit. No clock, no randomness, no I/O, no network:
// a pure function of the batches the harness sends, so two graded runs agree byte for byte.
//
// Entry (first ticket 0.02 SOL, age 2..60 slots after CreateEvent):
//   - real SOL reserve >= 5 SOL, total bought >= 3 SOL, distinct non-creator buyers >= 10
//   - creator has not sold; no single non-creator sell larger than 25% of the reserve
//   - free cash covers the ticket plus the tx fee; at most 5 open positions
// Pyramid: +0.15 SOL each time the real reserve at least doubles vs the last buy, up to
//   0.60 SOL per coin in total.
// Exits (whole position, value = what selling all tokens pays after curve fees, less tx):
//   - hard stop at -30% of cost; trailing stop: once +20%, exit on a 40% fall from the best
//   - reserve drawdown: real SOL reserve falls under half its peak while held
//   - creator sells while held; holding longer than 1000 slots.
//
// Anchor: makefun anchor d419540ce72eef9fa67ea3f3d683750c6b293ba9 round 34252959
// Revision pass 1: first full version (traction gate + pyramid + exits above).
// Revision pass 2: graded 9 variants locally (each ~22 s, --driver process --worktree):
//   v1 (traction gate, pyramid, 40%-from-peak trail) -0.848 SOL, 186 coins
//   v2 trailing = give back half the peak gain: -0.815
//   v3 stricter gate (buyers 15, bought 5, real 8): -0.534
//   v4 buy slippage 10000 -> 500 bps: -0.392
//   v5 hard stop -30% -> -15%: -0.372
//   v6 pyramid off: -0.229
//   v7 run-up cap +80%: -0.056, 28 coins
//   v8 age 60 -> 20: -0.022 but 18 coins, guardrail FAILS
//   v9 +50% take-profit: -0.019
//   v10 trailing give-back 1/3: -0.030 (reverted)
//   v11 run-up +120%: -0.044, 47 coins (reverted)
//   v12 TP +30%: -0.041 (reverted)
//   v13 stop -10%: -0.010
//   v14 (SHIPPED) earlier+cheaper entry: buyers 8, bought 2, real 3, run-up <=50%,
//       0.01 SOL ticket, stop -10%, TP +50%: +0.0057 SOL, 52 coins, guardrails met.
// Lessons: pyramid adds buy tops; the run-up cap is the single biggest filter; the
// edge is thin (90% interval straddles 0, top 3 coins = 72% of gains) — a lottery
// ticket, not a robust edge. Kept the config that clears dev PnL > 0 with the most
// coins, not the single best point.

const LAMPORTS_PER_SOL = 1_000_000_000n;
const BPS = 10_000n;
const FEE_BPS = 125n; // protocol 95 + creator 30 bps charged on curve trades.

const TICKET = 10_000_000n; // 0.01 SOL first ticket.
const ADD = 150_000_000n; // 0.15 SOL per pyramid add.
const MAX_PER_COIN = 20_000_000n; // 0.02 SOL total per coin (pyramid off for this test).
const MIN_BUYERS = 8;
const MIN_REAL_SOL = 3_000_000_000n; // 3 SOL real reserve at entry.
const MIN_BOUGHT = 2_000_000_000n; // 2 SOL bought before entry.
const MAX_BIG_SELL_BPS = 2_500n; // 25% of reserve: one big dump disqualifies.
const MAX_RUNUP_BPS = 5_000n; // skip a coin whose price already ran >50% above create.
const MIN_AGE = 2;
const MAX_AGE = 60;
const MAX_OPEN = 5;
const MAX_HOLD = 1000;
const STOP_BPS = 1_000n; // -10% hard stop.
const TP_BPS = 5_000n; // +50% full take-profit.
const TRAIL_ARM_BPS = 2_000n; // trailing stop arms at +20%.
const TRAIL_GIVEBACK_BPS = 5_000n; // exit once the position gives back half its peak gain.
const DRAW_DOWN_BPS = 5_000n; // exit when real reserve falls 50% from its peak.
const BUY_SLIPPAGE_BPS = 500; // refuse a buy whose price ran >5% in the latency.
const SELL_SLIPPAGE_BPS = 10_000;

type Pubkey = string;

interface Curve {
  mint: Pubkey;
  createSlot: number;
  creator: Pubkey;
  vq0: bigint;
  vt0: bigint;
  devBuy: bigint;
  trades: number;
  buyers: Set<Pubkey>;
  bought: bigint;
  soldByOthers: bigint;
  bigSellBps: bigint;
  devSold: boolean;
  lastTradeSlot: number;
  done: boolean;
  complete: boolean;
  buysSent: number;
  spentSent: bigint;
  lastBuyRq: bigint;
  lastBuySlot: number;
  peakRq: bigint;
}

interface Held {
  openedSlot: number;
  txPaid: bigint;
  best: bigint;
  peakRq: bigint;
  devSoldAtOpen: boolean;
}

/** What selling `tokens` against (vq, vt) pays after curve fees. */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * FEE_BPS + BPS - 1n) / BPS;
}

interface Order {
  side: 'buy' | 'sell';
  client_id: string;
  mint: Pubkey;
  quote_lamports?: string;
  token_amount?: string;
  max_slippage_bps: number;
}

interface State {
  cash: bigint;
  positions: Map<Pubkey, { token_amount: bigint; cost_lamports: bigint }>;
  curves: Map<Pubkey, { vq: bigint; vt: bigint; rq: bigint; rt: bigint; complete: boolean; slot: number }>;
  pending: Map<string, Order>;
  seq: number;
  slot: number;
  txFee: bigint;
  maxOpen: number;
  maxOrdersPerBatch: number;
  maxOrderBps: number;
}

const coins = new Map<Pubkey, Curve>();
const held = new Map<Pubkey, Held>();
let nextId = 1;
let filledCount = 0;

function clientId(): string {
  return `o${nextId++}`;
}

function maxBuyLamports(st: State, mint: Pubkey): bigint {
  const c = st.curves.get(mint);
  if (c === undefined || c.complete) return 0n;
  return (c.rq * BigInt(st.maxOrderBps)) / BPS;
}

function hasPendingBuy(st: State, mint: Pubkey): boolean {
  for (const p of st.pending.values()) if (p.mint === mint && p.side === 'buy') return true;
  return false;
}

function hasPendingSell(st: State, mint: Pubkey): boolean {
  for (const p of st.pending.values()) if (p.mint === mint && p.side === 'sell') return true;
  return false;
}

function freeCash(st: State): bigint {
  let free = st.cash;
  for (const p of st.pending.values()) {
    free -= st.txFee;
    if (p.side === 'buy') free -= BigInt(p.quote_lamports!);
  }
  return free;
}

function readEvents(batch: any): void {
  for (const e of batch.events) {
    if (e.event === 'CreateEvent') {
      coins.set(e.mint, {
        mint: e.mint,
        createSlot: e.slot,
        creator: e.creator,
        vq0: BigInt(e.virtual_quote_reserves),
        vt0: BigInt(e.virtual_token_reserves),
        devBuy: 0n,
        trades: 0,
        buyers: new Set(),
        bought: 0n,
        soldByOthers: 0n,
        bigSellBps: 0n,
        devSold: false,
        lastTradeSlot: e.slot,
        done: false,
        complete: false,
        buysSent: 0,
        spentSent: 0n,
        lastBuyRq: 0n,
        lastBuySlot: 0,
        peakRq: 0n,
      });
    } else if (e.event === 'TradeEvent') {
      const c = coins.get(e.mint);
      if (c === undefined) continue;
      const sol = BigInt(e.sol_amount);
      c.trades += 1;
      c.lastTradeSlot = e.slot;
      const isDev = e.user === c.creator;
      if (e.is_buy) {
        c.bought += sol;
        if (isDev && e.slot === c.createSlot) c.devBuy += sol;
        else if (!isDev) c.buyers.add(e.user);
      } else if (isDev) {
        c.devSold = true;
      } else {
        c.soldByOthers += sol;
        const rqBefore = BigInt(e.real_quote_reserves) + sol;
        if (rqBefore > 0n) {
          const bps = (sol * BPS) / rqBefore;
          if (bps > c.bigSellBps) c.bigSellBps = bps;
        }
      }
    } else if (e.event === 'CompleteEvent') {
      const c = coins.get(e.mint);
      if (c !== undefined) {
        c.complete = true;
        c.done = true;
      }
    }
  }
}

function onBatch(st: State, batch: any): Order[] {
  readEvents(batch);
  const orders: Order[] = [];
  const cap = st.maxOrdersPerBatch;
  const tx = st.txFee;

  // Fold fills: harness closes (client_id starting with _) drop the held record.
  for (const f of batch.fills) {
    if (f.client_id.startsWith('_')) {
      held.delete(f.mint);
      continue;
    }
    if (f.status === 'filled') filledCount += 1;
    const h = held.get(f.mint);
    if (f.status !== 'rejected' && h !== undefined) h.txPaid += BigInt(f.tx_fee_lamports);
    if (f.side === 'buy' && f.status === 'filled' && h === undefined) {
      const c = coins.get(f.mint);
      held.set(f.mint, {
        openedSlot: f.slot,
        txPaid: BigInt(f.tx_fee_lamports),
        best: 0n,
        peakRq: c !== undefined ? c.peakRq : 0n,
        devSoldAtOpen: c?.devSold ?? false,
      });
    }
  }
  // Drop held records for positions that are gone with nothing pending.
  for (const mint of [...held.keys()]) {
    if (!st.positions.has(mint) && !hasPendingSell(st, mint) && !hasPendingBuy(st, mint)) held.delete(mint);
  }

  // --- Exits first. ---
  for (const [mint, pos] of st.positions) {
    if (orders.length >= cap) break;
    if (hasPendingSell(st, mint)) continue;
    const c = coins.get(mint);
    let h = held.get(mint);
    if (h === undefined) {
      h = { openedSlot: st.slot, txPaid: tx, best: 0n, peakRq: 0n, devSoldAtOpen: c?.devSold ?? false };
      held.set(mint, h);
    }
    const cv = st.curves.get(mint);
    if (cv === undefined) continue;
    const value = sellValue(pos.token_amount, cv.vq, cv.vt) - tx;
    const basis = pos.cost_lamports + h.txPaid;
    if (value > h.best) h.best = value;
    if (cv.rq > h.peakRq) h.peakRq = cv.rq;
    let exit = false;
    if (basis > 0n) {
      if (value * BPS <= basis * (BPS - STOP_BPS)) exit = true;
      if (value * BPS >= basis * (BPS + TP_BPS)) exit = true;
      // Trailing stop: once the best value is +20% over cost, exit when the position
      // has given back more than half its peak gain (never turns a win into a big loss).
      if (h.best * BPS >= basis * (BPS + TRAIL_ARM_BPS)) {
        const keep = basis + ((h.best - basis) * (BPS - TRAIL_GIVEBACK_BPS)) / BPS;
        if (value <= keep) exit = true;
      }
    }
    if (h.peakRq > 0n && cv.rq * BPS <= h.peakRq * (BPS - DRAW_DOWN_BPS)) exit = true;
    if (st.slot - h.openedSlot >= MAX_HOLD) exit = true;
    if (c !== undefined && c.devSold && !h.devSoldAtOpen) exit = true;
    if (!exit) continue;
    orders.push({ side: 'sell', client_id: clientId(), mint, token_amount: pos.token_amount.toString(), max_slippage_bps: SELL_SLIPPAGE_BPS });
    if (c !== undefined) c.done = true;
  }

  // --- Entries and pyramid adds. ---
  let free = freeCash(st) - tx * BigInt(orders.length);
  let open = st.positions.size;
  for (const p of st.pending.values()) if (p.side === 'buy') open += 1;
  for (const c of coins.values()) {
    if (orders.length >= cap) break;
    if (c.done || c.complete) continue;
    const age = st.slot - c.createSlot;
    const isAdd = c.buysSent > 0;
    if (!isAdd && age > MAX_AGE) {
      c.done = true;
      continue;
    }
    if (age < MIN_AGE) continue;
    const curve = st.curves.get(c.mint);
    if (curve === undefined || curve.complete) continue;
    if (c.devSold) {
      if (!isAdd) c.done = true;
      continue;
    }
    if (curve.rq > c.peakRq) c.peakRq = curve.rq;
    if (isAdd) {
      if (!st.positions.has(c.mint) || hasPendingSell(st, c.mint) || hasPendingBuy(st, c.mint)) continue;
      if (c.spentSent >= MAX_PER_COIN) continue;
      if (st.slot - c.lastBuySlot < 2) continue;
      if (curve.rq < c.lastBuyRq * 2n) continue; // pyramid only on a doubling of real reserves.
      const maxAdd = maxBuyLamports(st, c.mint);
      const want = MAX_PER_COIN - c.spentSent < ADD ? MAX_PER_COIN - c.spentSent : ADD;
      const amount = want < maxAdd ? want : maxAdd;
      if (amount < 5_000_000n || free < amount + tx) continue;
      orders.push({ side: 'buy', client_id: clientId(), mint: c.mint, quote_lamports: amount.toString(), max_slippage_bps: BUY_SLIPPAGE_BPS });
      free -= amount + tx;
      c.buysSent += 1;
      c.spentSent += amount;
      c.lastBuyRq = curve.rq;
      c.lastBuySlot = st.slot;
      continue;
    }
    // First ticket: the traction gate.
    if (open >= MAX_OPEN) continue;
    if (curve.rq < MIN_REAL_SOL) continue;
    if (c.bought < MIN_BOUGHT) continue;
    if (c.buyers.size < MIN_BUYERS) continue;
    if (c.bigSellBps > MAX_BIG_SELL_BPS) continue;
    // Do not chase a coin that already ran far above its create price.
    if (curve.vt > 0n && c.vt0 > 0n) {
      const runupBps = (curve.vq * c.vt0 * BPS) / (curve.vt * c.vq0) - BPS;
      if (runupBps > MAX_RUNUP_BPS) continue;
    }
    const maxBuy = maxBuyLamports(st, c.mint);
    const amount = TICKET < maxBuy ? TICKET : maxBuy;
    if (amount < 5_000_000n || free < amount + tx) continue;
    orders.push({ side: 'buy', client_id: clientId(), mint: c.mint, quote_lamports: amount.toString(), max_slippage_bps: BUY_SLIPPAGE_BPS });
    free -= amount + tx;
    c.buysSent += 1;
    c.spentSent += amount;
    c.lastBuyRq = curve.rq;
    c.lastBuySlot = st.slot;
    open += 1;
  }
  return orders;
}

// ---------------------------------------------------------------- the wire

async function main(): Promise<void> {
  let buf = '';
  let state: State | null = null;
  const stdin = process.stdin;
  stdin.setEncoding('utf8');
  for await (const chunk of stdin) {
    buf += chunk;
    let idx: number;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.trim() === '') continue;
      const msg = JSON.parse(line);
      if (msg.type === 'hello') {
        state = {
          cash: BigInt(msg.capital.lamports),
          positions: new Map(),
          curves: new Map(),
          pending: new Map(),
          seq: -1,
          slot: -1,
          txFee: BigInt(msg.fees.base_fee_lamports) + BigInt(msg.fees.priority_fee_lamports),
          maxOpen: msg.caps.max_open_positions,
          maxOrdersPerBatch: msg.caps.max_orders_per_batch,
          maxOrderBps: msg.caps.max_order_bps_of_real_reserve,
        };
      } else if (msg.type === 'batch') {
        if (state === null) throw new Error('batch before hello');
        const st = state;
        st.seq = msg.seq;
        st.slot = msg.slot;
        // Fold fills, account, marks, events (same order as the reference shim).
        for (const f of msg.fills) st.pending.delete(f.client_id);
        st.cash = BigInt(msg.account.cash_lamports);
        st.positions.clear();
        for (const p of msg.account.positions) {
          const tokens = BigInt(p.token_amount);
          if (tokens > 0n) st.positions.set(p.mint, { token_amount: tokens, cost_lamports: BigInt(p.cost_lamports) });
        }
        for (const m of msg.marks) {
          const c = st.curves.get(m.mint);
          if (c !== undefined && m.slot < c.slot) continue;
          const curve = c ?? { vq: 0n, vt: 0n, rq: 0n, rt: 0n, complete: false, slot: m.slot };
          curve.vq = BigInt(m.virtual_quote_reserves);
          curve.vt = BigInt(m.virtual_token_reserves);
          curve.rq = BigInt(m.real_quote_reserves);
          curve.rt = BigInt(m.real_token_reserves);
          curve.slot = m.slot;
          st.curves.set(m.mint, curve);
        }
        for (const e of msg.events) {
          if (e.event === 'CreateEvent') {
            const curve = { vq: BigInt(e.virtual_quote_reserves), vt: BigInt(e.virtual_token_reserves), rq: 0n, rt: BigInt(e.real_token_reserves), complete: false, slot: e.slot };
            st.curves.set(e.mint, curve);
          } else if (e.event === 'TradeEvent') {
            const curve = st.curves.get(e.mint) ?? { vq: 0n, vt: 0n, rq: 0n, rt: 0n, complete: false, slot: e.slot };
            curve.vq = BigInt(e.virtual_quote_reserves);
            curve.vt = BigInt(e.virtual_token_reserves);
            curve.rq = BigInt(e.real_quote_reserves);
            curve.rt = BigInt(e.real_token_reserves);
            curve.slot = e.slot;
            st.curves.set(e.mint, curve);
          } else {
            const curve = st.curves.get(e.mint) ?? { vq: 0n, vt: 0n, rq: 0n, rt: 0n, complete: false, slot: e.slot };
            curve.complete = true;
            st.curves.set(e.mint, curve);
          }
        }
        const orders = onBatch(st, msg);
        if (orders.length > st.maxOrdersPerBatch) throw new Error(`batch ${msg.seq}: ${orders.length} orders over cap ${st.maxOrdersPerBatch}`);
        const reply = JSON.stringify({ type: 'reply', seq: msg.seq, orders });
        if (Buffer.byteLength(reply) > 65_536) throw new Error(`batch ${msg.seq}: reply over 64 KiB`);
        for (const o of orders) st.pending.set(o.client_id, o);
        process.stdout.write(reply + '\n');
      } else if (msg.type === 'done') {
        if (state === null) throw new Error('done before hello');
        console.error(`done: cash=${state.cash} positions=${state.positions.size} fills=${filledCount}`);
        return;
      } else {
        throw new Error(`unknown message type ${String(msg.type)}`);
      }
    }
  }
  throw new Error('input ended before done');
}

await main();
