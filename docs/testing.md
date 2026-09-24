# Tests

Code: `test/`. Run them with `npm test`. `npm run check` runs the type check and the tests
together; do that before committing. GitHub runs the same check on every push
(`.github/workflows/check.yml`).

## Why this project has tests

Everything this project concludes rests on measuring correctly: which price was known when, which
moves count, how much evidence there really is. Those rules are easy to break without noticing,
because a broken measurement still produces plausible-looking numbers. The tests pin the rules
down so a future change that breaks one fails loudly instead.

They use Node's built-in test runner, so there's nothing extra to install. They need no network,
no keys, and no waiting, and the whole set runs in about a second.

## What's covered

| File | What it protects |
|---|---|
| `book.test.ts` | the order book: best prices, inserting and removing levels, size near the price |
| `state.test.ts` | "the price at time t" never uses a later price; **the price is unknown during a feed outage**; order flow is signed and windowed correctly; **a replayed snapshot knows nothing from its own future** |
| `quotes.test.ts` | stock price history: spreads kept over time, bad quotes ignored, older prices only fill in the past, prices unknown while the connection is down |
| `stats.test.ts` | percentiles and rank correlation; **missing is never treated as zero**; bursts of decisions count as one piece of evidence |
| `instruments.test.ts` | which assets an item is about; `$ETH` isn't mistaken for a stock; how assets are named to Jev; **US market hours across daylight saving and weekends** |
| `sources.test.ts` | reading RSS, Atom, and RDF feeds; SEC filing entries; the company list; X searches and posts |
| `memory.test.ts` | what counts as a repeat headline, and which earlier headlines Jev is shown |
| `binanceus.test.ts` | the Binance.US feed: the book rebuilt from a snapshot plus the changes held while it was fetched, **a snapshot older than the stream fetched again**, any missed change meaning a rebuild, and which side made a trade happen |
| `microstructure.test.ts` | the order-book measurements the research and the order-book model use: size added to the bid or taken off the ask counts as buying pressure, trades and mid moves are counted per window, **a window reaching back before the data is unknown rather than zero**, and a break in the feed starts the windows over |
| `ridge.test.ts` | the order-book model: **the live code gives exactly the answers Python's fit gave** (to nine decimal places, from examples saved with the weights), every input it needs is one the live engine measures, values are clipped as in the fit, the calm condition, and the fee setting (per fill, with an old round-trip `FEE_BPS` still meaning the same cost) |
| `lean.test.ts` | reading Jev's lean against its usual one: the middle of the last 15 minutes of answers, old ones dropping out, unknown until there are enough; **an answer is never part of its own "usual"**; older records get exactly the reading a live run would have made |
| `model.test.ts` | how "flat" scales with volatility; the exact wording of questions; which failures are worth retrying; timeouts hidden inside the gateway's own errors |
| `news-engine.test.ts` | (also: the dashboard is told what became of every headline, and why) the news loop end to end: one call per item, **no call when the outcome can't be measured**, repeats skipped, rate limits waited out, failures retried at most three times, records completed correctly |
| `live-engine.test.ts` | the market-data loop: warm-up, spacing, pausing after a refusal, **waiting minutes, not a second, when the account is out of credits**, starting over after a feed break; the order-book model's calls and the quotes a trade would have crossed saved with every decision; each answer recorded with its usual lean and its corrected one, saved as "unknown" rather than zero while there is none |
| `lib.test.ts` | pause lengths after refusals, feed back-off, the "already seen" memory |
| `recorder.test.ts` | a saved recording holds every event and is readable once closed |
| `telemetry.test.ts` | messages for the dashboard leave together and later, never while the pipeline's own code is running; **a dashboard that's off, missing, or sent something unsendable is never the pipeline's problem** |
| `charts.test.ts` | the price chart's markers: a busy window is thinned enough to draw, a quiet one keeps every call, and **what is on screen never changes as the window slides over it or a new call arrives** |
| `collector.test.ts` | what the dashboard makes of each message: a question, its answer and its outcome end up together; restarts of the pipeline don't mix decisions up; history is bounded; headlines restored from disk slot in correctly |
| `outcomes.test.ts` | the dashboard's scoreboard: only decisions where the price moved are judged, unknown stays unknown, Jev is scored both as answered and with its usual lean taken out, and a Jev that merely repeats a rule scores nothing beyond it |
| `pnl.test.ts` | the dashboard's profit and loss: a right call earns the move and a wrong one pays it, **the fee charged on both fills and the spread on top**, what the moves alone were worth kept apart from what trading cost, unmoved trades kept apart from losses; the order-book rule trades only a call whose expected move beats the whole round trip, waits for a calm market at 10 s but not at 60 s, and says how close it came when it took nothing; the corrected rule trades "less down than usual" as a lean up and makes no call while the usual lean is unknown; the selective rule needs the order book to agree, stakes by the strength of the lean up to twice the normal stake, ignores TypeSafe's confidence, and **never uses a headline from after the decision**; a Jev call is traded only when calls like it caught more than the round trip, **counting only calls that had finished by then**, from the last four hours and the same strength band, with a margin for luck that counts calls close together as fewer; each rule is judged by its own calls, and what every call would have made is kept whether traded or not |
| `track.test.ts` | Jev's track record: each rule's calls kept with what they caught, none kept before its strength is known or its horizon has finished, old calls forgotten, and where one strength band ends and the next begins |

## How the engines are tested without the outside world

`test/helpers.ts` has three stand-ins:

- **A scripted model.** It answers the same way every time, after first playing out a list you
  give it: `['rate-limit', 'ok']` means "refuse the first call, answer the second". That makes it
  possible to test what happens on the third failure in a row, which you can't arrange with a
  real service. It also returns the extra details the real gateway returns (cost, TypeSafe's time,
  confidence), so recording them is tested too.
- **Fake prices.** Whatever the test says they are, optionally drifting over time so that "the
  price 10 seconds later" is a different, checkable number.
- **A clock the test controls.** The news engine takes its clock as a setting, so a test can say
  "it's Wednesday noon in New York" or "five minutes have passed" without waiting, and tests
  about market hours pass on a Saturday.

## The one check tests can't replace

Tests show each rule holds in isolation. They don't show the whole pipeline is free of peeking at
the future. For that, run the practice model through a real recording and check it scores about
zero ([backtest-and-analysis.md](backtest-and-analysis.md#how-we-checked-the-reports-themselves)).

## Adding tests

Put the file in `test/` with a name ending in `.test.ts`. Name each test after the rule it
protects, in plain words ("while the feed is broken the price is unknown, not unchanged"), so a
failure explains itself.
