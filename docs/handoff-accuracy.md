# Handoff: improving 10 s and 60 s direction accuracy

> **Done, 2026-09-23.** The work this note set up is written up in [accuracy.md](accuracy.md),
> and its results are in the pipeline (decisions D54 to D57). The note is kept as it was for its
> history. Two things in it have changed: the Pi is now reached at its Tailscale address,
> `100.64.35.57` (the home-network address below no longer answered), and costs are no longer out
> of scope. `research/accuracy.py` still works, but `research/extract.ts` and `research/fit.py`
> replaced it for this question.

Written 2026-09-23 for a new session to pick up. Nothing here has changed the pipeline's
behaviour yet. What exists is a data pull, an analysis script, and a first set of findings.

## The task

Use the days of data the Raspberry Pi has collected to improve how often the pipeline calls the
next move up or down, at the **10 second and 60 second** horizons only. Those two are the ones
slow enough that an order could be placed and filled before the call goes stale. **Accuracy is
the only goal for this pass.** Fees, position sizing, and profit are out of scope.

## Where things are

**The Pi.** Address `10.0.0.177`, user `cristicol`, project in `~/code/jev-hft`. Four systemd
services run there: `jev-hft@live`, `jev-hft@news-live`, `jev-hft@record`, `jev-hft@dashboard`.
The dashboard is at `http://10.0.0.177:4000`.

**SSH access.** This machine's public key was installed on the Pi on 2026-09-23, so
`ssh cristicol@10.0.0.177` works without a password. The password itself is deliberately not
written here. It was shared in a chat, so it should be changed on the Pi (`passwd`), and password
login can then be switched off (`PasswordAuthentication no` in `/etc/ssh/sshd_config`).

**Data on this machine.** Everything is under `data/`, which git ignores, so a fresh clone has
none of it. Copy it with:

```bash
rsync -a cristicol@10.0.0.177:code/jev-hft/data/decisions/ data/decisions/
rsync -a cristicol@10.0.0.177:code/jev-hft/data/news/ data/news/
rsync -a cristicol@10.0.0.177:code/jev-hft/data/raw/ data/raw/      # 735 MB
```

| Path | What it is |
|---|---|
| `data/decisions/live-typesafe-2026-09-21T00-13-43-…jsonl` | 253 MB. The main run, straight to TypeSafe. Still being written on the Pi, so re-pull for newer decisions. |
| `data/decisions/live-gateway-…jsonl` (three files) | 47 MB in total. Earlier runs through the Vercel gateway, 2026-09-20. |
| `data/decisions/news-*.jsonl`, `data/news/items-*.jsonl` | The news path. Not used in this pass. |
| `data/raw/BTC-USD-2026-09-20T01-58-59-…jsonl.gz` | 735 MB. Every Coinbase book and trade event from 2026-09-20 to 2026-09-23. Can be replayed through `MarketState` to compute any feature at any moment. |

## What has been done

1. **Pulled the data off the Pi** (above).
2. **Wrote `research/accuracy.py`** (Python 3 and numpy only). Run it as
   `python3 research/accuracy.py data/decisions/live-*.jsonl`. It:
   - re-parses every feature Jev was shown from each record's state text, so any feature can be
     tested without touching the pipeline;
   - rebuilds Jev's lean correction exactly as `src/model/lean.ts` does it;
   - scores each signal by how often it points the right way, on all calls and on its strongest
     half, quarter, and tenth;
   - splits a signal by Jev's own "flat" probability, and by whether Jev and the book agree;
   - fits logistic regressions on the earlier 60% of the time range and tests on the later 40%,
     and also rolls hour by hour, training only on earlier hours.
3. **Read the first results.** See below. The full printed output is not saved in the repo, so
   rerun the script to see it (about two minutes).

Scoring conventions to keep: signals are scored from when Jev's answer arrived, decisions where
the price did not move are left out of hit rates, and significance is judged from the count of
separate stretches of time, not the count of decisions, because decisions one second apart share
almost the same future.

## What the data says so far

Basis: 181,337 decisions across 96.8 hours of wall time, 53.5 hours of which had decisions
running (pauses over five minutes are not counted). About 106,000 calls errored during the run,
which matches the credits running out, so the decisions that exist are a subset of the run.

**10 seconds ahead.** The price rose 44.0% of the time, fell 45.0%, and was unchanged 11.0%.

| Signal | Pointed the right way | Rank score (IC) |
|---|---|---|
| Book imbalance, best level | 55.9% | 0.124 |
| Book imbalance, five levels | 55.7% | 0.114 |
| Jev, usual lean taken out | 54.7% | 0.093 |
| Jev, as answered | 53.5% | 0.092 |
| Order flow, price momentum, depth, reversal | 50 to 52% | 0.00 to 0.03 |

- On the strongest tenth of calls, book imbalance reaches 62 to 64% and Jev 59 to 60%.
- A weighted fit on the book alone, tested on the later 40%, scores **56.1%** on all calls,
  **62.2%** on the strongest quarter, and **64.3%** on the strongest tenth.
- Adding every measurement Jev was shown does not help (56.0%). Adding Jev's corrected answer
  does not help either (56.0%). Jev on its own scores 54.5%.
- The test set holds about 7,000 separate stretches of time, so 56% is well above chance.
- **One small lead:** when Jev's "flat" probability is high, the book is right less often.
  Book imbalance was right 58.8% of the time when Jev's chance of flat was below 0.25, and 54.2%
  when it was above 0.68. Nothing else in this pass separated good moments from bad ones.
- When Jev and the book agree (73% of calls) they are right 57.3% of the time. When they
  disagree, following the book wins 52.1% against 47.9% for Jev.
- Accuracy swings a lot by hour: some hours reach 62 to 68%, others sit at 51 to 53%. A model
  that knows which regime it is in could gain more than any new feature.

**60 seconds ahead.** The price rose 49.3% of the time and fell 50.0%.

- Nothing separates from a coin flip. The best single signal is five-level book imbalance at
  52.0%, and the best fit tops out at 52.3% on all calls and 54.4% on its strongest tenth.
- Jev's answer scores 50.1% as answered and 49.0% in a walk-forward fit, no better than chance.
- The test set holds only about 1,250 separate stretches, so 52% is within noise (one standard
  error is about 1.4 points).
- The docs already record that 60-second results have once been fooled by a downward drift. Do
  not accept a 60-second gain unless it holds on days that played no part in choosing it.

## What was about to be tried

The next step was interrupted. It is the most promising one, because everything above uses only
the six lines of text Jev sees, and the raw recording holds far more.

1. **Replay `data/raw` through `MarketState`** (see `src/market/replay.ts`,
   `src/backtest.ts` for how a replay is set up) at one snapshot a second, and write one row per
   snapshot with richer measurements than the encoder shows:
   - **order-flow imbalance** at the best level and across several levels: the change in queue
     size on each side between snapshots, which usually predicts short-term direction better than
     a static imbalance;
   - the **change** in imbalance over 1, 5, and 10 seconds, not only its level;
   - microprice and depth-weighted imbalance, book slope, and time since the mid last moved;
   - trade-sign persistence and size-weighted flow over several windows;
   - the spread, volatility, and hour of day, as regime markers.
2. Attach forward mids at 10 s and 60 s, measured from a fixed short delay after the snapshot so
   the numbers stay tradable.
3. Fit and test **by day**, never within a day. `pip install scikit-learn lightgbm` may work
   here (it was not tried), which would allow gradient boosting. Numpy alone is enough for
   logistic fits, and `accuracy.py` already has one.
4. **Keep the last full day untouched** until a single final check. The script so far uses a
   60/40 split plus an hourly rolling test, and has no locked hold-out.
5. Test regime gating: acting only in hours or volatility bands where the fit is accurate, and
   using Jev's "flat" probability as a filter.
6. Only after a rule wins on held-out days, change the signals in `src/engine.ts` and
   `src/dashboard/pnl.ts` so the live pipeline uses it, and add a test.

## Things to know

- **Jev is not the strongest input.** Across four days it adds nothing to a fit that already has
  the book. Improving accuracy here most likely means better features and better gating, with
  Jev as one input among several, rather than better prompts. Showing Jev fewer inputs is listed
  in `docs/model.md` as an idea and would need paid calls.
- **Credits.** The Pi's counters showed most calls erroring at times. Check the dashboard health
  (`/api/health`) and the Pi's journal (`journalctl -u jev-hft@live`) before relying on new Jev
  answers.
- **The dashboard only keeps about 30 minutes.** It is no substitute for the files.
- `research/` is plain Python and is not part of `npm run check`.
