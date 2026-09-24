#!/usr/bin/env python3
"""Accuracy study for the 10 s and 60 s direction calls.

Reads decision records (data/decisions/live-*.jsonl, or the dashboard poller's decisions.jsonl),
recovers every feature Jev was shown from the state text, and asks, out of sample:

  1. How often does each signal point the right way at 10 s and 60 s, and how does that change
     when we only act on its strongest calls?
  2. Does a fixed weighted rule over the features beat book imbalance alone?  (walk-forward fit)
  3. Does adding Jev's answer to that rule change anything?

Everything is scored from when the answer arrived (tradable), on moves that were not zero.
"""
from __future__ import annotations

import json
import math
import re
import sys
from collections import defaultdict

import numpy as np

HORIZONS = [2, 10, 60]
LEAN_WINDOW_MS = 15 * 60_000
LEAN_MIN = 60

# ---- loading ----------------------------------------------------------------------------

NUM = r'([+-]?\d+(?:\.\d+)?|n/a)'
LINE1 = re.compile(r'^(\S+) (\d\d):(\d\d) UTC mid ([\d.]+) \(bid ([\d.]+) / ask ([\d.]+), spread ([\d.]+)bp\)')
LINE2 = re.compile(rf'mid returns: 1s {NUM}bp, 5s {NUM}bp(?: \(z {NUM}\))?, 30s {NUM}bp, 60s {NUM}bp; 1s volatility {NUM}(?:bp)?(?: \(z {NUM}\))?')
LINE3 = re.compile(rf'taker flow, buy minus sell \(\w+\): 1s {NUM}, 5s {NUM}(?: \(z {NUM}\))?, 30s {NUM}')
LINE4 = re.compile(rf'last 5s: (\d+) trades(?: \(z {NUM}\))? \((\d+) buy / (\d+) sell\), largest ([\d.]+) (\w+|-)')
LINE5 = re.compile(rf'book imbalance \(bid-ask\)/\(bid\+ask\): L1 {NUM}(?: \(z {NUM}\))?, L5 {NUM}(?: \(z {NUM}\))?, L20 {NUM}')
LINE6 = re.compile(r'depth within 10bp: bid ([\d.]+), ask ([\d.]+)')


def f(x):
    return float('nan') if x is None or x == 'n/a' else float(x)


def parse_state(text: str) -> dict:
    l = text.split('\n')
    m1, m2, m3, m4, m5, m6 = (r.search(x) for r, x in zip((LINE1, LINE2, LINE3, LINE4, LINE5, LINE6), l))
    if not all((m1, m2, m3, m4, m5, m6)):
        raise ValueError('unparsed state:\n' + text)
    hour, minute = int(m1[2]), int(m1[3])
    side = m4[6]
    return dict(
        hour=hour, minute=minute, tod=hour + minute / 60,
        mid=f(m1[4]), spread=f(m1[7]),
        ret1=f(m2[1]), ret5=f(m2[2]), ret5z=f(m2[3]), ret30=f(m2[4]), ret60=f(m2[5]), vol60=f(m2[6]), vol60z=f(m2[7]),
        flow1=f(m3[1]), flow5=f(m3[2]), flow5z=f(m3[3]), flow30=f(m3[4]),
        trades5=f(m4[1]), trades5z=f(m4[2]), buys5=f(m4[3]), sells5=f(m4[4]), maxTrade5=f(m4[5]),
        maxSide=1.0 if side == 'buy' else -1.0 if side == 'sell' else 0.0,
        imb1=f(m5[1]), imb1z=f(m5[2]), imb5=f(m5[3]), imb5z=f(m5[4]), imb20=f(m5[5]),
        depthBid=f(m6[1]), depthAsk=f(m6[2]),
    )


def bps(to, frm):
    if to is None or frm is None:
        return float('nan')
    return (to - frm) / frm * 1e4


def load(paths: list[str]) -> list[dict]:
    """One flat dict per finished decision, from either file format."""
    rows = []
    for p in paths:
        for line in open(p):
            line = line.strip()
            if not line:
                continue
            r = json.loads(line)
            if 'answer' in r:  # dashboard poller format
                a = r['answer']
                probs = a['probabilities']
                moves = {h: (a and r['outcome']['fromResp'].get(str(h))) for h in HORIZONS}
                moves = {h: (float('nan') if v is None else v) for h, v in moves.items()}
                row = dict(t=r['tState'], tResp=a['tResp'], flat=r['flatBps'], probs=probs, conf=a.get('confidence', {}), moves=moves, src=p)
            else:  # DecisionRecord
                probs = r['probabilities']
                moves = {h: bps(r['fwdResp'].get(str(h)), r['midResp']) for h in HORIZONS}
                row = dict(t=r['tState'], tResp=r['tResp'], flat=r.get('flatBps', {}), probs=probs, conf=r.get('confidence', {}), moves=moves, src=p)
            try:
                row.update(parse_state(r['state']))
            except ValueError:
                continue
            for h in HORIZONS:
                pr = probs.get(f'dir_{h}s') or {}
                row[f'p_up_{h}'] = pr.get('up', float('nan'))
                row[f'p_dn_{h}'] = pr.get('down', float('nan'))
                row[f'p_flat_{h}'] = pr.get('flat', float('nan'))
                row[f'jev_{h}'] = row[f'p_up_{h}'] - row[f'p_dn_{h}']
            rows.append(row)
    # dedupe (files can overlap) and sort by arrival, which is the order the lean correction needs
    seen = set()
    out = []
    for r in sorted(rows, key=lambda r: r['tResp']):
        if r['t'] in seen:
            continue
        seen.add(r['t'])
        out.append(r)
    return out


def fill_leans(rows: list[dict]):
    """Exactly what src/model/lean.ts does: each answer read against the median of the previous 15 min."""
    for h in HORIZONS:
        times, vals = [], []
        for r in rows:
            t = r['tResp']
            while times and times[0] < t - LEAN_WINDOW_MS:
                times.pop(0)
                vals.pop(0)
            x = r[f'jev_{h}']
            if len(vals) >= LEAN_MIN:
                usual = float(np.median(vals))
                r[f'usual_{h}'] = usual
                r[f'jevc_{h}'] = x - usual
                r[f'typ_{h}'] = float(np.mean(np.abs(np.array(vals) - usual)))
            else:
                r[f'usual_{h}'] = r[f'jevc_{h}'] = r[f'typ_{h}'] = float('nan')
            if math.isfinite(x):
                times.append(t)
                vals.append(x)


# ---- scoring ----------------------------------------------------------------------------

def independent(times, gap_ms):
    n, last = 0, -math.inf
    for t in sorted(times):
        if t - last >= gap_ms:
            n += 1
            last = t
    return n


def spearman(a, b):
    a, b = np.asarray(a, float), np.asarray(b, float)
    k = np.isfinite(a) & np.isfinite(b)
    if k.sum() < 3:
        return float('nan')
    ra = a[k].argsort().argsort().astype(float)
    rb = b[k].argsort().argsort().astype(float)
    # ties: average ranks
    def avg_rank(x):
        order = np.argsort(x, kind='mergesort')
        ranks = np.empty(len(x))
        i = 0
        xs = x[order]
        while i < len(x):
            j = i
            while j + 1 < len(x) and xs[j + 1] == xs[i]:
                j += 1
            ranks[order[i:j + 1]] = (i + j) / 2
            i = j + 1
        return ranks
    ra, rb = avg_rank(a[k]), avg_rank(b[k])
    return float(np.corrcoef(ra, rb)[0, 1])


def hit_rate(signal, move):
    """Share pointing the right way, over decisions where both had a direction. Returns (hit, n)."""
    s, m = np.asarray(signal, float), np.asarray(move, float)
    k = np.isfinite(s) & np.isfinite(m) & (s != 0) & (m != 0)
    if k.sum() == 0:
        return float('nan'), 0
    return float((np.sign(s[k]) == np.sign(m[k])).mean()), int(k.sum())


def coverage_curve(signal, move, times, horizon_s, fracs=(1.0, 0.5, 0.25, 0.1)):
    """Accuracy when acting only on the strongest `frac` of calls (by |signal|)."""
    s, m, t = np.asarray(signal, float), np.asarray(move, float), np.asarray(times, float)
    k = np.isfinite(s) & np.isfinite(m) & (s != 0) & (m != 0)
    s, m, t = s[k], m[k], t[k]
    out = []
    for frac in fracs:
        if len(s) == 0:
            out.append((frac, float('nan'), 0, 0, float('nan')))
            continue
        thr = np.quantile(np.abs(s), 1 - frac) if frac < 1 else 0
        sel = np.abs(s) >= thr
        hit = float((np.sign(s[sel]) == np.sign(m[sel])).mean())
        avg = float((np.sign(s[sel]) * m[sel]).mean())
        out.append((frac, hit, int(sel.sum()), independent(t[sel], max(horizon_s, 5) * 1000), avg))
    return out


# ---- models -----------------------------------------------------------------------------

def logistic_fit(X, y, l2=1.0, iters=50):
    """L2-regularised logistic regression by Newton's method. y in {0,1}. Returns weights (intercept first)."""
    n, d = X.shape
    Xb = np.hstack([np.ones((n, 1)), X])
    w = np.zeros(d + 1)
    reg = np.eye(d + 1) * l2
    reg[0, 0] = 0
    for _ in range(iters):
        z = Xb @ w
        p = 1 / (1 + np.exp(-z))
        g = Xb.T @ (p - y) + reg @ w
        W = p * (1 - p)
        H = (Xb * W[:, None]).T @ Xb + reg
        step = np.linalg.solve(H, g)
        w -= step
        if np.abs(step).max() < 1e-8:
            break
    return w


def logistic_predict(w, X):
    Xb = np.hstack([np.ones((X.shape[0], 1)), X])
    return 1 / (1 + np.exp(-(Xb @ w)))


class Standardizer:
    def fit(self, X):
        self.mu = np.nanmean(X, axis=0)
        self.sd = np.nanstd(X, axis=0) + 1e-9
        return self

    def apply(self, X):
        Z = (X - self.mu) / self.sd
        return np.nan_to_num(Z, nan=0.0)  # a missing input is "ordinary", never a huge number


FEATURE_SETS = {
    'book':        ['imb1', 'imb5', 'imb20'],
    'book+depth':  ['imb1', 'imb5', 'imb20', 'depthImb'],
    'market':      ['imb1', 'imb5', 'imb20', 'depthImb', 'flow1', 'flow5', 'flow30', 'ret1', 'ret5', 'ret30', 'ret60', 'tradeImb', 'maxSideSize'],
    'market+z':    ['imb1', 'imb5', 'imb20', 'depthImb', 'flow1', 'flow5', 'flow30', 'ret1', 'ret5', 'ret30', 'ret60', 'tradeImb', 'maxSideSize', 'imb1z', 'imb5z', 'flow5z', 'ret5z', 'vol60z', 'trades5z'],
}


def design(rows, names, h=None):
    cols = []
    for r in rows:
        v = dict(r)
        v['depthImb'] = (r['depthBid'] - r['depthAsk']) / (r['depthBid'] + r['depthAsk']) if (r['depthBid'] + r['depthAsk']) > 0 else 0.0
        v['tradeImb'] = (r['buys5'] - r['sells5']) / r['trades5'] if r['trades5'] > 0 else 0.0
        v['maxSideSize'] = r['maxSide'] * r['maxTrade5']
        if h is not None:
            v['jevc'] = r[f'jevc_{h}']
            v['jev'] = r[f'jev_{h}']
            v['pflat'] = r[f'p_flat_{h}']
        cols.append([v[n] for n in names])
    return np.array(cols, float)


# ---- report -----------------------------------------------------------------------------

def fmt(x, d=1):
    return '-' if x is None or not math.isfinite(x) else f'{x:.{d}f}'


def pct(x):
    return '-' if not math.isfinite(x) else f'{x * 100:.1f}%'


def section(title):
    print('\n' + title)
    print('-' * len(title))


def main(paths):
    rows = load(paths)
    fill_leans(rows)
    t0, t1 = rows[0]['t'], rows[-1]['t']
    print(f'{len(rows)} finished decisions from {len(paths)} file(s), '
          f'{(t1 - t0) / 3.6e6:.1f} h span ({np.datetime64(int(t0), "ms")} to {np.datetime64(int(t1), "ms")} UTC)')
    times = np.array([r['t'] for r in rows], float)
    gaps = np.diff(times)
    print(f'covered {(gaps[gaps < 300_000].sum()) / 3.6e6:.1f} h of decisions (gaps over 5 min not counted); median spacing {np.median(gaps) / 1000:.2f}s')

    for h in HORIZONS:
        move = np.array([r['moves'][h] for r in rows], float)
        ok = np.isfinite(move)
        flat = np.array([r['flat'].get(f'dir_{h}s', float('nan')) for r in rows], float)
        print(f'  {h:>3}s: {ok.sum()} scored; price rose {pct((move[ok] > 0).mean())}, fell {pct((move[ok] < 0).mean())}, unchanged {pct((move[ok] == 0).mean())}; '
              f'mean |move| {np.abs(move[ok]).mean():.2f}bp; beyond the "flat" band {pct((np.abs(move[ok]) > flat[ok]).mean())}')

    # ---- 1. every signal, and its coverage curve ----
    for h in (10, 60):
        section(f'{h}s AHEAD  —  how often each signal points the right way, acting on all calls, then only the strongest half / quarter / tenth')
        move = np.array([r['moves'][h] for r in rows], float)
        signals = {
            f'jev_{h} (as answered)': [r[f'jev_{h}'] for r in rows],
            f'jevc_{h} (lean taken out)': [r[f'jevc_{h}'] for r in rows],
            'obi1': [r['imb1'] for r in rows],
            'obi5': [r['imb5'] for r in rows],
            'obi20': [r['imb20'] for r in rows],
            'depth imbalance 10bp': [(r['depthBid'] - r['depthAsk']) for r in rows],
            'flow5': [r['flow5'] for r in rows],
            'flow30': [r['flow30'] for r in rows],
            'mom5': [r['ret5'] for r in rows],
            'reversal (-ret60)': [-r['ret60'] for r in rows],
            'trade imbalance 5s': [(r['buys5'] - r['sells5']) for r in rows],
        }
        print(f'  {"signal":28} {"IC":>6}   {"all":>18}   {"top 50%":>18}   {"top 25%":>18}   {"top 10%":>18}')
        print(f'  {"":28} {"":>6}   {"hit%  n  avg bp":>18}   {"hit%  n  avg bp":>18}   {"hit%  n  avg bp":>18}   {"hit%  n  avg bp":>18}')
        for name, s in signals.items():
            ic = spearman(s, move)
            curve = coverage_curve(s, move, times, h)
            cells = '   '.join(f'{pct(hit):>6} {n:>5} {fmt(avg, 2):>5}' for _, hit, n, _, avg in curve)
            print(f'  {name:28} {fmt(ic, 3):>6}   {cells}')

    # ---- 2. Jev's probabilities as a filter ----
    for h in (10, 60):
        section(f'{h}s AHEAD  —  does Jev\'s "flat" probability tell us when NOT to trade?  (book imbalance obi1, split by Jev\'s p(flat))')
        move = np.array([r['moves'][h] for r in rows], float)
        pflat = np.array([r[f'p_flat_{h}'] for r in rows], float)
        obi = np.array([r['imb1'] for r in rows], float)
        flat = np.array([r['flat'].get(f'dir_{h}s', float('nan')) for r in rows], float)
        k = np.isfinite(pflat) & np.isfinite(move)
        if k.sum() < 100:
            print('  too few')
            continue
        qs = np.quantile(pflat[k], [0.2, 0.4, 0.6, 0.8])
        edges = [-1, *qs, 2]
        print(f'  {"p(flat) band":22} {"n":>6}  {"mean |move| bp":>14}  {"beyond band":>11}  {"obi1 hit%":>9}  {"jevc hit%":>9}')
        for lo, hi in zip(edges[:-1], edges[1:]):
            sel = k & (pflat > lo) & (pflat <= hi)
            hit_o, n_o = hit_rate(obi[sel], move[sel])
            jc = np.array([r[f'jevc_{h}'] for r in rows], float)
            hit_j, _ = hit_rate(jc[sel], move[sel])
            print(f'  {fmt(max(lo, 0), 2):>5} .. {fmt(min(hi, 1), 2):<12} {sel.sum():>6}  {np.abs(move[sel]).mean():>14.2f}  {pct((np.abs(move[sel]) > flat[sel]).mean()):>11}  {pct(hit_o):>9}  {pct(hit_j):>9}')

    # ---- 3. walk-forward fits ----
    for h in (10, 60):
        section(f'{h}s AHEAD  —  walk-forward fits: train on the first part, test on the rest (never the same hours)')
        move = np.array([r['moves'][h] for r in rows], float)
        y_dir = np.sign(move)
        usable = np.isfinite(move) & (move != 0)
        # Split by time: first 60% train, last 40% test. Also report a 3-fold rolling version below.
        n = len(rows)
        cut = int(n * 0.6)
        sets = dict(FEATURE_SETS)
        sets['market + jevc'] = FEATURE_SETS['market'] + ['jevc']
        sets['market + jevc + pflat'] = FEATURE_SETS['market'] + ['jevc', 'pflat']
        sets['market+z + jevc'] = FEATURE_SETS['market+z'] + ['jevc']
        sets['jevc alone'] = ['jevc']
        print(f'  {"features":24} {"n train":>7} {"n test":>7} {"ind":>5}   {"all":>14}   {"top 50%":>14}   {"top 25%":>14}   {"top 10%":>14}   weights (largest first)')
        for name, feats in sets.items():
            X = design(rows, feats, h)
            tr = np.arange(n) < cut
            te = ~tr
            ktr = tr & usable & np.isfinite(X).all(axis=1)
            kte = te & usable & np.isfinite(X).all(axis=1)
            if ktr.sum() < 200 or kte.sum() < 100:
                print(f'  {name:24} too few rows with every input known ({ktr.sum()} train, {kte.sum()} test)')
                continue
            st = Standardizer().fit(X[ktr])
            w = logistic_fit(st.apply(X[ktr]), (y_dir[ktr] > 0).astype(float), l2=1.0)
            p = logistic_predict(w, st.apply(X[kte]))
            sig = p - 0.5
            curve = coverage_curve(sig, move[kte], times[kte], h)
            cells = '   '.join(f'{pct(hit):>6} {nn:>5}' for _, hit, nn, _, _ in curve)
            top = sorted(zip(feats, w[1:]), key=lambda kv: -abs(kv[1]))[:5]
            ws = ', '.join(f'{k}={v:+.2f}' for k, v in top)
            print(f'  {name:24} {ktr.sum():>7} {kte.sum():>7} {curve[0][3]:>5}   {cells}   {ws}')

        # Rolling: train on everything before each hour-block, test on that block (needs >= 3 h)
        hours = ((times - times[0]) // 3.6e6).astype(int)
        blocks = sorted(set(hours))
        if len(blocks) >= 4:
            print(f'\n  rolling by hour (train on all earlier hours, test on this one), hit% on all calls / strongest quarter:')
            print(f'  {"hour":>4} {"n":>5}   ' + '   '.join(f'{name:>16}' for name in ['obi1', 'market', 'market + jevc', 'jevc alone']))
            agg = defaultdict(lambda: [0, 0, 0, 0])
            for b in blocks[2:]:
                tr = (hours < b) & usable
                te = (hours == b) & usable
                if te.sum() < 100:
                    continue
                cells = []
                for name in ['obi1', 'market', 'market + jevc', 'jevc alone']:
                    if name == 'obi1':
                        sig = np.array([r['imb1'] for r in rows], float)[te]
                    else:
                        feats = sets[name]
                        X = design(rows, feats, h)
                        ktr = tr & np.isfinite(X).all(axis=1)
                        kte = te & np.isfinite(X).all(axis=1)
                        if ktr.sum() < 200 or kte.sum() < 50:
                            cells.append(f'{"-":>16}')
                            continue
                        st = Standardizer().fit(X[ktr])
                        w = logistic_fit(st.apply(X[ktr]), (y_dir[ktr] > 0).astype(float), l2=1.0)
                        # keep rows aligned with te
                        full = np.full(te.sum(), np.nan)
                        full[kte[te]] = logistic_predict(w, st.apply(X[kte])) - 0.5
                        sig = full
                    c = coverage_curve(sig, move[te], times[te], h, fracs=(1.0, 0.25))
                    cells.append(f'{pct(c[0][1]):>7} /{pct(c[1][1]):>7}')
                    a = agg[name]
                    a[0] += (np.sign(sig) == np.sign(move[te]))[np.isfinite(sig) & (sig != 0) & (move[te] != 0)].sum()
                    a[1] += (np.isfinite(sig) & (sig != 0) & (move[te] != 0)).sum()
                    ss = np.abs(np.nan_to_num(sig))
                    thr = np.quantile(ss[ss > 0], 0.75) if (ss > 0).any() else 0
                    sel = np.isfinite(sig) & (ss >= thr) & (move[te] != 0)
                    a[2] += (np.sign(sig[sel]) == np.sign(move[te][sel])).sum()
                    a[3] += sel.sum()
                print(f'  {b:>4} {te.sum():>5}   ' + '   '.join(cells))
            print(f'  {"all":>4} {"":>5}   ' + '   '.join(f'{pct(a[0] / a[1] if a[1] else float("nan")):>7} /{pct(a[2] / a[3] if a[3] else float("nan")):>7}' for a in (agg[n] for n in ['obi1', 'market', 'market + jevc', 'jevc alone'])))

    # ---- 4. agreement filter ----
    for h in (10, 60):
        section(f'{h}s AHEAD  —  agreement: Jev (lean taken out) and the book')
        move = np.array([r['moves'][h] for r in rows], float)
        jc = np.array([r[f'jevc_{h}'] for r in rows], float)
        obi = np.array([r['imb1'] for r in rows], float)
        obi5 = np.array([r['imb5'] for r in rows], float)
        k = np.isfinite(jc) & np.isfinite(move) & (move != 0) & (jc != 0) & (obi != 0)
        agree = k & (np.sign(jc) == np.sign(obi))
        disagree = k & (np.sign(jc) != np.sign(obi))
        both5 = agree & (np.sign(obi5) == np.sign(obi))
        for name, sel, sig in [('agree (trade the shared side)', agree, obi), ('disagree, follow Jev', disagree, jc), ('disagree, follow book', disagree, obi), ('agree and obi5 too', both5, obi)]:
            hit, n = hit_rate(sig[sel], move[sel])
            print(f'  {name:32} {pct(hit):>7}  n {n:>6}  share of calls {pct(sel.sum() / max(k.sum(), 1)):>6}  avg bp {fmt((np.sign(sig[sel]) * move[sel]).mean(), 2)}')

    # ---- 5. time of day ----
    section('BY HOUR OF DAY (UTC)  —  obi1 hit% at 10s / 60s, and jevc hit%')
    buckets = defaultdict(list)
    for r in rows:
        buckets[r['hour']].append(r)
    print(f'  {"hour":>4} {"n":>6}  {"|move| 10s":>10} {"obi1 10s":>9} {"jevc 10s":>9}  {"|move| 60s":>10} {"obi1 60s":>9} {"jevc 60s":>9}')
    for hour in sorted(buckets):
        rs = buckets[hour]
        cells = []
        for h in (10, 60):
            mv = np.array([r['moves'][h] for r in rs], float)
            ho, _ = hit_rate([r['imb1'] for r in rs], mv)
            hj, _ = hit_rate([r[f'jevc_{h}'] for r in rs], mv)
            cells.append(f'{np.nanmean(np.abs(mv)):>10.2f} {pct(ho):>9} {pct(hj):>9}')
        print(f'  {hour:>4} {len(rs):>6}  ' + '  '.join(cells))


if __name__ == '__main__':
    if len(sys.argv) < 2:
        sys.exit('usage: accuracy.py <decisions.jsonl> [...]')
    main(sys.argv[1:])
