"""Fits and tests 10 s and 60 s direction models on the rows research/extract.ts writes.

    python3 research/fit.py data/research/rows [--jev data/decisions/live-*.jsonl]
    python3 research/fit.py data/research/rows --final --export src/model/weights

Needs numpy; also fits boosted trees for comparison if LightGBM is installed (pip install lightgbm).
The findings, and why each choice below was made, are in docs/accuracy.md.

How it keeps itself honest:
- Rows are split by UTC day, never within one. Choices are made on walk-forward folds (train on
  every earlier day, test on the next). The last full day is locked away and scored only with
  --final, once the choices are made. Days after it are not used.
- Two minutes either side of a day boundary are dropped, so no training label overlaps a test row.
- Moves are measured from an entry ENTRY_MS after the snapshot, at the bid or ask on the book then,
  not at the mid the snapshot saw.
- "Strongest share" is set by the size of the predictions on the day being tested, which uses no
  outcomes (a live run can do the same from its own recent predictions). It lets models be
  compared at the same number of trades.
- Rows are one second apart but a label spans 10 or 60 of them, so standard errors come from the
  number of non-overlapping stretches, not the number of rows.

Cost of trading: a round trip crosses the spread (buy at the ask, sell at the bid) and pays the
exchange's fee on each side. The report sets what each rule caught against that.
"""

import argparse
import json
import os
from datetime import datetime, timezone

import numpy as np

try:
    import lightgbm as lgb
except ImportError:  # everything but the tree comparison still runs
    lgb = None

ENTRY_MS = 300
HORIZONS = (10, 60)
PURGE_S = 120
SHARES = (1.0, 0.5, 0.25, 0.1)
# A move this size or bigger is one that could matter for a fee (about the median move).
BIG_BPS = {10: 1.0, 60: 3.0}
# The six book measurements the chosen model uses (docs/accuracy.md: more inputs did no better).
BOOK = ["imb1", "imb2", "imb3", "imb5", "microBps", "l1LogRatio"]
RIDGE_ALPHA = 100.0
# BTC-USD's price increment on Coinbase, for the "spread is one tick" condition.
TICK_USD = 0.01
# The calm condition: 60 s volatility below this quantile of the training days. It lifted the
# 10 s model's share right by about three points on every test day and did nothing at 60 s, so
# the live rule applies it only where it was shown to help.
CALM_QUANTILE = 2 / 3
CALM_GATE_HORIZONS = (10,)
# Fee per side in bps. Coinbase Advanced Trade's published schedule ran from 60 bps taker (40
# maker) at the smallest tier to 5 taker (0 maker) at the largest when this was written; check
# the current one.
FEES_PER_SIDE = (0.0, 0.5, 1.0, 2.5, 5.0, 60.0)

NOT_FEATURES = {"t", "bid", "ask", "mid"}
NOT_DIRECTIONAL = ("vol", "tcount", "moves", "since", "l1Depth", "spread", "tod", "depth", "trades", "buys", "sells")


def load(prefix):
    head = json.load(open(prefix + ".json"))
    cols = head["columns"]
    if len(set(cols)) != len(cols):
        raise SystemExit(f"{prefix}.json repeats a column name; re-run research/extract.ts")
    x = np.fromfile(prefix + ".f64").reshape(-1, len(cols))
    return {c: x[:, i].copy() for i, c in enumerate(cols)}, head


def labels(d, h, entry_ms=ENTRY_MS):
    """Mid move in bps from entry to exit, and the spread a round trip would have crossed, in bps."""
    eb, ea = d[f"entryBid_{entry_ms}"], d[f"entryAsk_{entry_ms}"]
    xb, xa = d[f"exitBid_{entry_ms}_{h}"], d[f"exitAsk_{entry_ms}_{h}"]
    em, xm = (eb + ea) / 2, (xb + xa) / 2
    spread = ((ea - eb) / em + (xa - xb) / xm) / 2 * 1e4
    return (xm - em) / em * 1e4, spread


def day_name(k):
    return datetime.fromtimestamp(k * 86_400, timezone.utc).strftime("%Y-%m-%d")


def feature_names(d, tod=False):
    names = [c for c in d if c not in NOT_FEATURES and not c.startswith(("entry", "exit", "jev"))]
    return names if tod else [c for c in names if not c.startswith("tod")]


# ---------------------------------------------------------------- models


class Linear:
    """Ridge regression on winsorized, standardized inputs. A missing value counts as average."""

    def __init__(self, names, alpha=RIDGE_ALPHA):
        self.names, self.alpha = names, alpha

    def prep(self, X):
        Z = (np.clip(X, self.lo, self.hi) - self.mu) / self.sd
        return np.where(np.isfinite(Z), Z, 0.0)

    def fit(self, X, y):
        self.lo = np.nanpercentile(X, 0.5, axis=0)
        self.hi = np.nanpercentile(X, 99.5, axis=0)
        Xc = np.clip(X, self.lo, self.hi)
        self.mu = np.nanmean(Xc, axis=0)
        sd = np.nanstd(Xc, axis=0)
        self.sd = np.where(sd > 0, sd, 1.0)
        ok = np.isfinite(y)
        Z, y = self.prep(X[ok]), y[ok]
        self.b0 = float(y.mean())
        self.w = np.linalg.solve(Z.T @ Z + self.alpha * np.eye(Z.shape[1]), Z.T @ (y - self.b0))
        return self

    def predict(self, X):
        return self.prep(X) @ self.w + self.b0

    def export(self):
        return {"kind": "ridge", "features": self.names, "lo": self.lo.tolist(), "hi": self.hi.tolist(),
                "mean": self.mu.tolist(), "sd": self.sd.tolist(), "weights": self.w.tolist(), "intercept": self.b0}


class Gbm:
    """Boosted trees, for comparison only: they did not do clearly better, and a linear fit is simpler to run live."""

    def __init__(self, names, rounds=300):
        self.names, self.rounds = names, rounds

    def fit(self, X, y):
        ok = np.isfinite(y)
        params = dict(objective="huber", alpha=1.0, learning_rate=0.03, num_leaves=15, min_data_in_leaf=2000,
                      feature_fraction=0.7, bagging_fraction=0.7, bagging_freq=1, lambda_l2=10.0, verbose=-1, seed=1)
        self.m = lgb.train(params, lgb.Dataset(X[ok], y[ok]), self.rounds)
        return self

    def predict(self, X):
        return self.m.predict(X)


class Sign:
    """One measurement as it stands: its sign is the call, its size the strength."""

    def __init__(self, names):
        self.names = names

    def fit(self, X, y):
        return self

    def predict(self, X):
        return X[:, 0]


# ---------------------------------------------------------------- scoring


def rank_ic(a, b):
    ok = np.isfinite(a) & np.isfinite(b)
    if ok.sum() < 10:
        return np.nan
    return float(np.corrcoef(np.argsort(np.argsort(a[ok])), np.argsort(np.argsort(b[ok])))[0, 1])


def strongest(pred, share):
    """The calls in the strongest `share`, by the size of the predictions themselves."""
    a = np.abs(pred)
    ok = np.isfinite(a) & (pred != 0)
    if share >= 1.0:
        return ok
    return ok & (a >= np.quantile(a[ok], 1 - share))


def scores(pred, move, h, share):
    """Share right (moves of zero left out), share right on big moves, mean move caught, calls."""
    sel = strongest(pred, share) & np.isfinite(move)
    called = sel & (move != 0)
    big = sel & (np.abs(move) >= BIG_BPS[h])
    right = lambda m: float((np.sign(pred[m]) == np.sign(move[m])).mean()) if m.any() else np.nan
    caught = float((np.sign(pred[sel]) * move[sel]).mean()) if sel.any() else np.nan
    return dict(hit=right(called), big=right(big), caught=caught, n=int(called.sum()), trades=int(sel.sum()))


def line(name, pred, move, h, extra=""):
    cells = [f"{name:38s} IC {rank_ic(pred, move):+.3f}"]
    for share in SHARES:
        s = scores(pred, move, h, share)
        se = 0.5 / np.sqrt(max(1.0, s["n"] / h))
        cells.append(f"{share*100:>3.0f}%: {s['hit']*100:4.1f}±{se*100:.1f} (big {s['big']*100:4.1f}, {s['caught']:+.2f}bp)")
    return "  ".join(cells) + extra


def cost_table(pred, move, spread, h, indent="   "):
    """What each share of calls caught, what the spread took, and what is left at each fee."""
    print(f"{indent}cost of trading at {h}s, per trade. Round trip = the spread (crossed going in and coming out) + the fee on each side:")
    for share in SHARES:
        sel = strongest(pred, share) & np.isfinite(move) & np.isfinite(spread)
        if not sel.any():
            continue
        caught = float((np.sign(pred[sel]) * move[sel]).mean())
        sp = float(spread[sel].mean())
        after = "  ".join(f"{f:g}bp/side {caught - sp - 2 * f:+.2f}" for f in FEES_PER_SIDE)
        print(f"{indent}  strongest {share*100:>3.0f}%: caught {caught:+.3f} bp, spread {sp:.3f} bp, "
              f"break-even fee {(caught - sp) / 2:+.3f} bp/side | net: {after}")


def calm_gate(d, m, vol_cut):
    """Where the book model was most often right: a quiet minute and a one-tick spread."""
    return (d["vol60"][m] < vol_cut) & ((d["ask"][m] - d["bid"][m]) < 1.5 * TICK_USD)


# ---------------------------------------------------------------- Jev


def load_jev(paths, t_rows):
    """Jev's lean (as answered and corrected) and its flat probability, on the first row at or after the answer arrived."""
    out = {f"{k}_{h}s": np.full(len(t_rows), np.nan) for k in ("jev", "jevc", "jevflat") for h in HORIZONS}
    for p in paths:
        with open(p) as fh:
            for raw in fh:
                try:
                    r = json.loads(raw)
                except ValueError:
                    continue
                i = int(np.searchsorted(t_rows, r["tResp"]))
                if i >= len(t_rows) or t_rows[i] - r["tResp"] > 1000:
                    continue
                s = r.get("signals", {})
                for h in HORIZONS:
                    for k in ("jev", "jevc"):
                        v = s.get(f"{k}_{h}s")
                        if isinstance(v, (int, float)):
                            out[f"{k}_{h}s"][i] = v
                    flat = r.get("probabilities", {}).get(f"dir_{h}s", {}).get("flat")
                    if isinstance(flat, (int, float)):
                        out[f"jevflat_{h}s"][i] = flat
    return out


# ---------------------------------------------------------------- main


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("prefix")
    ap.add_argument("--final", action="store_true", help="also score the locked last day (do this once)")
    ap.add_argument("--jev", nargs="*", default=[])
    ap.add_argument("--export", help="directory to write the chosen models to, for the live pipeline")
    args = ap.parse_args()

    d, head = load(args.prefix)
    t = d["t"]
    day = np.floor(t / 86_400_000).astype(int)
    into = t / 1000 - day * 86_400
    keep = (into > PURGE_S) & (into < 86_400 - PURGE_S)
    all_days = sorted(set(day.tolist()))
    full = [k for k in all_days if (day == k).sum() > 12 * 3600]
    locked = full[-1]
    dev_days = [k for k in all_days if k < locked]
    print(f"{len(t)} rows from {head['source']}")
    for k in all_days:
        print(f"  {day_name(k)}  {(day == k).sum():6d} rows  {'LOCKED' if k == locked else ('not used' if k > locked else '')}")
    if args.jev:
        d.update(load_jev(args.jev, t))
        print("rows with a corrected Jev answer:", int(np.isfinite(d["jevc_10s"]).sum()))

    feats = feature_names(d)
    dev = keep & np.isin(day, dev_days)

    def X(names, m):
        return np.column_stack([d[c][m] for c in names])

    def walk_forward(make, names, y, only=None):
        """Predictions for every walk-forward test day, trained on every day before it."""
        pred = np.full(len(t), np.nan)
        for i in range(1, len(dev_days)):
            tr, te = keep & np.isin(day, dev_days[:i]), keep & (day == dev_days[i])
            if only is not None:
                tr, te = tr & only, te & only
                if tr.sum() < 5000:
                    continue  # too few training seconds to say anything (Jev had almost none on the first day)
            pred[te] = make(names).fit(X(names, tr), y[tr]).predict(X(names, te))
        return pred

    tested = keep & np.isin(day, dev_days[1:])
    exported = {}
    for h in HORIZONS:
        move, spread = labels(d, h)
        sd = np.nanstd(move)
        y = np.clip(move, -5 * sd, 5 * sd)
        up, down = np.nanmean(move[keep] > 0), np.nanmean(move[keep] < 0)
        print(f"\n=================== {h}s ahead, entry {ENTRY_MS} ms after the snapshot")
        print(f"rose {up*100:.1f}%, fell {down*100:.1f}%, unchanged {(1-up-down)*100:.1f}%; |move| mean {np.nanmean(np.abs(move[keep])):.2f} bp, "
              f"median {np.nanmedian(np.abs(move[keep])):.2f} bp; spread crossed per round trip: median {np.nanmedian(spread[keep]):.4f} bp, mean {np.nanmean(spread[keep]):.3f} bp")
        a = np.abs(move[keep])
        print("perfect foresight (the most any rule could make), per second traded:")
        for f in FEES_PER_SIDE:
            worth = a > 2 * f + np.nanmean(spread[keep])
            print(f"   fee {f:4g} bp/side: {worth.mean()*100:5.1f}% of seconds move enough to pay for a round trip")

        print("\n-- single measurements over the development days (the sign of the value is the call)")
        singles = []
        for c in feats:
            if c.startswith(NOT_DIRECTIONAL):
                continue
            v, mv = d[c][dev], move[dev]
            ok = np.isfinite(v) & np.isfinite(mv) & (mv != 0) & (v != 0)
            singles.append((abs(rank_ic(v, mv)), c, (np.sign(v[ok]) == np.sign(mv[ok])).mean(), rank_ic(v, mv)))
        for _, c, hr, ic in sorted(singles, reverse=True)[:10]:
            print(f"   {c:16s} right {hr*100:5.1f}%  IC {ic:+.3f}")

        print(f"\n-- walk-forward over {', '.join(day_name(k) for k in dev_days[1:])}: share right ± 1 s.e. by strongest share of calls "
              f"(right on moves >= {BIG_BPS[h]:g} bp, mean move caught)")
        variants = {
            "book imbalance, best level (as before)": (Sign, ["imb1"]),
            "linear, six book measurements (chosen)": (Linear, BOOK),
            "linear, all 80 measurements": (lambda n: Linear(n, 1e5), feats),
        }
        if lgb:
            variants["boosted trees, all measurements"] = (Gbm, feats)
        preds = {}
        for name, (make, names) in variants.items():
            preds[name] = walk_forward(make, names, y)
            per_day = " ".join(f"{day_name(k)[5:]} {scores(preds[name][tested & (day == k)], move[tested & (day == k)], h, 1.0)['hit']*100:.1f}" for k in dev_days[1:])
            print("   " + line(name, preds[name][tested], move[tested], h, f"   [all calls by day: {per_day}]"))

        chosen = preds["linear, six book measurements (chosen)"]
        p, mv = chosen[tested], move[tested]
        print("\n-- the chosen model, looked at more closely")
        for dms in (0, 300, 1000):
            m2, _ = labels(d, h, dms)
            print("   " + line(f"entry {dms} ms after the snapshot", p, m2[tested], h))
        gate = np.zeros(len(t), bool)
        for i in range(1, len(dev_days)):
            tr, te = keep & np.isin(day, dev_days[:i]), keep & (day == dev_days[i])
            gate[te] = calm_gate(d, te, np.nanquantile(d["vol60"][tr], CALM_QUANTILE))
        g = gate[tested]
        print("   " + line(f"calm and one-tick spread ({g.mean()*100:.0f}% of seconds)", p[g], mv[g], h))
        print("   " + line("the other seconds", p[~g], mv[~g], h))
        q = np.nanquantile(p, np.linspace(0, 1, 11))
        cells = [f"{np.nanmean(p[(p >= q[j]) & (p <= q[j + 1])]):+.2f}->{np.nanmean(mv[(p >= q[j]) & (p <= q[j + 1])]):+.2f}" for j in range(10)]
        print("   predicted -> actual mean move (bp) by tenth of the prediction: " + "  ".join(cells))
        cost_table(p, mv, spread[tested], h)
        print("   ... calm seconds only:")
        cost_table(p[g], mv[g], spread[tested][g], h, indent="      ")

        if args.jev:
            has = np.isfinite(d[f"jevc_{h}s"])
            j = has[tested]
            print(f"\n-- the {j.sum()} walk-forward seconds that had a Jev answer")
            print("   " + line("linear, six book measurements", p[j], mv[j], h))
            print("   " + line("Jev, usual lean taken out", d[f"jevc_{h}s"][tested][j], mv[j], h))
            with_jev = walk_forward(Linear, BOOK + [f"jevc_{h}s", f"jevflat_{h}s"], y, only=has)
            without = walk_forward(Linear, BOOK, y, only=has)
            ok = np.isfinite(with_jev) & tested
            print("   " + line("book + Jev, fitted on Jev seconds only", with_jev[ok], move[ok], h))
            print("   " + line("book alone, same seconds", without[ok], move[ok], h))

        if args.final or args.export:
            model = Linear(BOOK).fit(X(BOOK, dev), y[dev])
            vol_cut = float(np.nanquantile(d["vol60"][dev], CALM_QUANTILE))
        if args.final:
            te = keep & (day == locked)
            p_l, mv_l = model.predict(X(BOOK, te)), move[te]
            g_l = calm_gate(d, te, vol_cut)
            print(f"\n-- LOCKED DAY {day_name(locked)}, every choice made and trained on the days before it")
            print("   " + line("book imbalance, best level (as before)", d["imb1"][te], mv_l, h))
            print("   " + line("linear, six book measurements (chosen)", p_l, mv_l, h))
            print("   " + line(f"   calm and one-tick spread ({g_l.mean()*100:.0f}%)", p_l[g_l], mv_l[g_l], h))
            if lgb:
                gb = Gbm(feats).fit(X(feats, dev), y[dev])
                print("   " + line("boosted trees, all measurements", gb.predict(X(feats, te)), mv_l, h))
            if args.jev:
                has = np.isfinite(d[f"jevc_{h}s"][te])
                if has.sum() > 1000:
                    print("   " + line(f"Jev, usual lean taken out ({has.sum()} seconds)", d[f"jevc_{h}s"][te][has], mv_l[has], h))
            cost_table(p_l, mv_l, spread[te], h)
        if args.export:
            out = model.export()
            train_pred = model.predict(X(BOOK, dev))
            a = np.abs(train_pred[np.isfinite(train_pred)])
            # A few rows with the answer the fit gave them, so a test can check the live code agrees.
            idx = np.linspace(0, dev.sum() - 1, 5).astype(int)
            rows = X(BOOK, dev)[idx]
            out.update(
                horizonS=h, entryMs=ENTRY_MS, trainedOn=[day_name(k) for k in dev_days], testedOn=day_name(locked),
                strongCut={str(s): float(np.quantile(a, 1 - s)) for s in SHARES if s < 1},
                calm={"gate": h in CALM_GATE_HORIZONS, "vol60Below": vol_cut, "maxSpreadTicks": 1, "tickUsd": TICK_USD},
                examples=[{"inputs": {c: (None if not np.isfinite(v) else float(v)) for c, v in zip(BOOK, r)}, "expected": float(e)}
                          for r, e in zip(rows, model.predict(rows))],
            )
            exported[h] = out
    if args.export:
        os.makedirs(args.export, exist_ok=True)
        for h, out in exported.items():
            path = os.path.join(args.export, f"ridge-{h}s.json")
            json.dump(out, open(path, "w"), indent=1)
            print(f"wrote {path}")


if __name__ == "__main__":
    main()
