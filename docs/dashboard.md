# The live dashboard

Code: `src/dashboard/` (the server and the page), `src/telemetry/` (what the pipeline sends it).
Run it with `npm run dashboard` and open <http://localhost:4000>.

## What it shows

Everything the pipeline is doing, as it does it:

**Market data** (when `npm run live` is running)

- The price, how far apart the bid and ask are, how delayed the data is, and how long one update
  takes to handle.
- A chart of the price with Jev's calls marked where and when each answer arrived: a triangle
  pointing up or down, bigger when the lean was stronger. A minute later each marker turns solid
  if the price went that way, hollow if it didn't. Three strips under the chart show the lean
  over time at 2, 10, and 60 seconds. Hover anywhere near a call to see its probabilities and
  what the price did next, marked or not.

  At one call a second a quarter of an hour holds about 900 of them, which is more than there
  are pixels, so only the first call in each slice of a few seconds gets a triangle. Which one
  that is depends only on when it arrived, never on where it sits in the list, so the markers
  stay put and simply scroll off the left edge rather than being reshuffled as the chart moves
  ([D53](decisions.md)).

  A call is Jev's answer read against what it has usually been saying, not the answer at face
  value. Jev leans "down" most of the time whatever the market does next, so an answer a little
  less down than usual is drawn, scored, and traded as a lean up
  ([model.md](model.md#reading-jevs-lean-against-its-usual-one)). A new run spends its first
  minute learning that usual lean and shows dots rather than calls until it has.
- The latest answer: the three probabilities for each horizon, the threshold that counted as
  "flat", the call that came out of it (with the answer it started from and Jev's usual lean
  beside it), and where the round trip's time went (TypeSafe against the network and gateway).
- Exactly the text Jev was shown, and the order-book measurements behind it.
- Response times, and the full journey from something happening on Coinbase to having an answer.
- **Jev against the simple rules:** how often each pointed the right way over the decisions
  finished so far in this run, and what's left of Jev's score once the rules are accounted for
  ([backtest-and-analysis.md](backtest-and-analysis.md)). Jev has two rows: with its usual lean
  taken out, which is what the pipeline acts on, and as answered, so the gap between them stays
  in view. Only decisions where the price actually moved are counted, and nothing is shown until
  there are at least 20 of those.
- **If you had traded Jev's answers:** the running total of what following Jev would have made,
  with the curve over the run, how many trades went which way, and the worst dip along the way.
  The rule is the plainest one that could really have been followed: take Jev's side at the mid
  price the moment the answer arrived, all the same size, and close at the horizon, but only
  when the call is expected to catch more than the round trip costs. Answers with no lean sit
  out. The buttons above the price chart pick which horizon it is worked out for.

  Jev doesn't say how far the price will move, so what a call is expected to catch comes from its
  track record: what earlier calls of about the same strength caught over the last four hours,
  counting only calls that had finished by then, less a margin for luck
  ([decisions.md](decisions.md) D59). At a taker's fees Jev's calls don't clear that bar: they
  catch a few tenths of a basis point, and a round trip costs several. So "no trades" is the
  usual state of this card, and it then says how close the calls came, and what all of them would
  have made had each been traded whatever it cost. That keeps a signal that is right but too
  small to trade apart from one that is simply wrong. A new run trades nothing for its first few
  minutes, until there are 50 finished calls of a strength to judge by.

  "At face value" on the same card is the same rule with Jev's answers taken as they came: its
  trades after costs, and what all its calls were worth before them. It is there as a yardstick:
  the correction was chosen on one day's data, and this shows, on every run since, whether it is
  still earning its place.

  Two things are worth keeping in mind when reading it. Trades overlap, so it assumes you could
  hold several at once. And every trade pays what trading really costs: the exchange's fee on
  both fills (`FEE_BPS_PER_SIDE`, 5 bp by default) and the spread it would have crossed. "Before
  costs" shows what the moves alone were worth and "costs" what paying for them took. "Went your
  way" is measured before costs, so it says how often the call itself was right. Over short
  horizons the price is often exactly where it started, and those trades are counted separately
  rather than as losses.
- **If you had traded selectively:** the same calls under a more careful rule, right next to the
  first so the two can be compared. It trades only when the best level of the order book points
  the same way as Jev, because when the two disagreed Jev was right less than half the time. It
  sits out if a headline from the last 15 minutes leans the other way, counting each headline from
  the moment Jev answered it (D60). It stakes more on a
  stronger lean: an ordinary lean gets the normal stake, a lean twice as strong as usual gets
  twice that, and nothing gets more. And like the first card, it trades a call only when its own
  track record, the earlier calls the book also agreed with, says the call will pay for itself.
  Stakes average out at about the normal one, so the two cards' totals can be compared directly;
  "average per stake" is what each unit staked made.

  Most of this rule's accuracy comes from the order book, not from Jev. The book alone points the
  right way about two times in three at 2 seconds. Jev's agreement adds a few points on top of
  that. Fresh, relevant news is often not available (most sources publish only a few times an
  hour), and when there is none the rule simply goes without it.
- **If you had traded the order-book model:** no Jev at all. The order-book model
  ([accuracy.md](accuracy.md)) says how far it expects the price to move, and this card takes a
  call only when that is more than the round trip would cost, and at 10 seconds only when the last
  minute was calm and the spread one tick, where the model was right most often. At a taker's
  fees it takes almost nothing, because the model's best calls expect well under a basis point,
  so when it has no trades it says how close it came: how many calls came in a calm market, the
  biggest move the model expected, and what a round trip cost. That gap is the finding, not a
  fault. Set `FEE_BPS_PER_SIDE=0` to see what any of the cards would do with no fees.
- **If you had traded the news:** Jev's verdict on each headline about Bitcoin, traded in the
  direction it leans at the price when the answer arrived, and closed 1, 5 or 30 minutes later
  (pick which with the card's own buttons; 30 minutes is what Jev is asked about). Unlike its
  second-by-second calls, Jev says how big a headline's move could be, so the card weighs that
  against the round trip the way the order-book card does: the chance the news matters, times how
  much more bullish than bearish it is, times the size its magnitude answer stands for (under
  0.2% counts as 10 bp, 0.2% to 1% as 60, over 1% as 150). A trade opens the moment Jev answers
  and shows as "still open" until its check comes due; its price then comes from the news
  program's own once-a-second price, and is replaced by the exact one when the headline's record
  is saved half an hour later. Headlines are rare, so this card counts every one the dashboard
  has kept (the last 500, restored from the news program's files on a restart), not just the
  last 50 minutes. See [decisions.md](decisions.md#d61-the-news-is-traded-when-jev-expects-a-move-bigger-than-the-cost).

The scoreboard has a row for the order-book model too, scored from the snapshot like the other
simple rules, since it takes microseconds.

**News** (when `npm run news` is running)

- How many headlines came in, how many Jev was asked about, and why the rest weren't (a repeat,
  the market closed, no usable price, waited too long).
- Every source, with how often it's been checked and how much it's delivered.
- The headlines themselves, newest first, with what Jev made of each: whether it matters, which
  way, how big, whether it's new. Open one to see exactly what Jev was shown. Thirty minutes later
  the price moves appear next to it.

The page is built for a desktop screen. News sits in a sidebar of roughly fixed width and the
market-data cards take everything else, laying themselves out in one, two or three columns
depending on how much room they have. That is measured against the width of their own column
rather than the window's, so the layout is right whatever else is on screen. On a 2560-wide
monitor the whole dashboard is three columns and very nearly one screenful; narrow the window
and the columns fold back down on their own, which is why there is no desktop/mobile switch to
remember.

Either side shows how to start its pipeline when that pipeline isn't running. A light in the top
bar shows whether each pipeline is alive (it should be heard from every second), and the button
at the top right switches between dark and light.

## How it stays out of the pipeline's way

The dashboard must never slow a decision down or put one at risk. Three choices guarantee that.

**It's a separate program.** `npm run dashboard` is its own process. Nothing about it runs
inside `live` or `news`: not the web server, not the browser connections, not the scoring. If it
crashes, hangs, or is never started, the pipeline doesn't know. You can stop and restart it at
any time, and the page reconnects by itself.

**The pipeline only ever sends, and never waits.** It reports what it's doing as small UDP
messages to the dashboard's port. UDP has no connection and no acknowledgement. There's no queue
that can fill up and push back. If nobody is listening, the messages vanish. Nothing is written
to disk for this.

**Nothing was added to the handling of a market update.** The pipeline handles 20 to 200 of
those a second, and none of them does any work for the dashboard. What the dashboard needs rides
along with things that happen anyway:

- when Jev is asked (once a second), the text and measurements already exist, so they're noted;
- when Jev answers, so is the answer;
- once a second, a "pulse" reads the current price and the running counters.

Even then, noting something only puts it on a list, which takes about 0.3 millionths of a second.
Turning it into text and sending it happens afterwards, once Node has dealt with any market data
that was already waiting (`setImmediate`). And the question is sent to Jev *before* the dashboard
is told about it, so telemetry is never between a snapshot and its request.

**What it costs, measured:**

| | |
|---|---|
| Noting an event, on the decision path | about 0.3 µs (a Jev answer takes about 260,000 µs) |
| Turning it into text and sending it, afterwards | about 5 µs |
| All of it, per second | about 15 µs: 0.0015% of one processor core |

**And the live check.** We ran copies of the pipeline side by side, so they saw the same market
at the same moment: some with telemetry off, one with it on, feeding the dashboard with a browser
attached. The number to watch is how long one market update takes to handle.

| Run | Telemetry off | Telemetry on, dashboard and browser attached |
|---|---|---|
| First (2 minutes, one copy each) | 36 µs typical, 636 µs slow case, 113 decisions | 38 µs typical, 633 µs slow case, 115 decisions |
| Second (2.7 minutes, two "off" copies) | 55.7 µs and 63.5 µs; 143 and 142 decisions | 63.4 µs; 143 decisions |

In the second run the two copies with identical settings differed from each other by 7.8 µs, and
the copy with telemetry landed between them. One copy's own 10-second windows ranged from 36 to
96 µs as the market got busier and quieter. So whatever telemetry costs is too small to tell
apart from chance, which is what the design predicts: handling a market update runs exactly the
same code either way.

`TELEMETRY=0` switches it off entirely, in which case the pipeline doesn't even build the
messages.

## How it works

```
  npm run live  ─┐
                 ├─ UDP, one way ─►  npm run dashboard  ─ live stream ─►  the page in your browser
  npm run news  ─┘                          ▲
                                            │ reads
                      data/decisions/*.jsonl, data/news/*.jsonl
                      (what the pipeline has already saved)
```

**What the pipeline sends** (`src/telemetry/`). `events.ts` lists every message: a pulse each
second, and for the market-data path "asked", "answered", and "failed"; for news "a headline
arrived", "not asked (and why)", "trying again", and "answered". `sender.ts` sends them. The
engines don't know about UDP; they're handed an `emit` function, which does nothing unless a
runner connects it, so tests and backtests are unaffected.

**The server** (`src/dashboard/server.ts`) does three things:

1. Listens for those messages and keeps recent history in memory: 30 minutes of prices and
   decisions, and the last 300 headlines.
2. Follows the pipeline's own result files to learn **what happened next**. A decision is only
   saved once its outcome is known (a minute later for market data, 30 minutes for news), so
   that's where "did the price go the way Jev said?" comes from. It reads those files; it never
   writes to them.
3. Serves the page, a snapshot of current state for a page that's just loaded, and a live stream
   of everything after that.

**When the dashboard starts after the pipeline,** it has missed the messages so far. The market
side refills within seconds. News is sparse, so recent headlines are restored from the items file
the pipeline keeps; ones whose answer was missed say so, and gain it once their finished record
is saved.

**The page** (`src/dashboard/web/`) is plain TypeScript with hand-drawn charts: no framework, no
packages, nothing to build, nothing fetched from the internet. Browsers can't run TypeScript, so
the server blanks the types out as it serves each file, which Node can do by itself and which
keeps line numbers identical to the source. `collector.ts` (what the dashboard knows, and how
each message changes it) is used by both the server and the page, so they can't disagree.

The page redraws at most once per screen refresh and only the parts that changed, and does
nothing at all while its tab is in the background.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `TELEMETRY` | `1` | where the pipeline sends its messages. `1` is this machine; `0` or `off` sends nothing; `host` or `host:port` sends them to another machine |
| `DASHBOARD_PORT` | `4000` | the page's port |
| `TELEMETRY_PORT` | `4100` | the port the dashboard listens on for the pipeline's messages |
| `DASHBOARD_HOST` | `127.0.0.1` | which network address to listen on. `0.0.0.0` makes the page reachable from other machines |
| `FEE_BPS_PER_SIDE` | `5` | the exchange's fee on each fill, in bp; every trade in the profit and loss pays it twice, plus the spread |
| `PNL_NOTIONAL_USD` | `10000` | the stake behind each trade, so the total can be shown in money |

## Watching a Raspberry Pi

Two ways, depending on where you'd rather the dashboard ran:

- **On the Pi:** `./deploy/pi/setup.sh --service dashboard`, with `DASHBOARD_HOST=0.0.0.0` in the
  Pi's `.env`. Then open `http://<pi-address>:4000` from your laptop.
- **On your laptop:** run `DASHBOARD_HOST=0.0.0.0 npm run dashboard` there, and put
  `TELEMETRY=<laptop-address>` in the Pi's `.env`. The Pi then does no dashboard work at all,
  though the laptop can't see the Pi's result files, so "what happened next" stays empty.

**The page has no password.** It can't control anything and shows no keys, only prices,
headlines, and decisions, but anyone who can reach it can read it. That's why it listens only on
your own machine unless you say otherwise. Use `0.0.0.0` only on a network you trust, and never
expose it to the internet.

## Changing it

- **A new number on the page:** if the pipeline already knows it at a decision or once a second,
  add it to the message in `events.ts` and where that message is emitted, then draw it in
  `web/views.ts`. Don't add anything to the handling of a market update.
- **A new kind of message:** add it to `events.ts`, handle it in `collector.ts` (with a test in
  `test/collector.test.ts`), and emit it from the engine through `emit`.
- The message format carries a version (`v: 1`). The dashboard ignores anything it doesn't
  understand, so an older dashboard and a newer pipeline can't hurt each other.
