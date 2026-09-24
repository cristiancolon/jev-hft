# Running jev-hft on a Raspberry Pi

This folder has everything needed to run the pipeline around the clock on a Raspberry Pi 5
(8 GB is plenty; the news pipeline uses about 175 MB of memory).

- `setup.sh` installs Node.js 24 if needed, installs the project's packages, checks your `.env`,
  and sets the pipeline up as a background service that starts at boot.
- `jev-hft@.service` is that service's definition, for systemd (the program that starts and
  looks after background services on Raspberry Pi OS).

## Steps

1. **Install the 64-bit Raspberry Pi OS** and connect the Pi to your network (a cable is steadier
   than Wi-Fi).
2. **Get the code onto the Pi:**
   ```bash
   git clone https://github.com/cristiancolon/jev-hft.git
   cd jev-hft
   ```
3. **Copy your `.env` from your computer** (it holds your keys, so it isn't on GitHub). From the
   computer that has it:
   ```bash
   scp .env <user>@<pi-address>:~/jev-hft/.env
   ```
4. **Run the setup on the Pi:**
   ```bash
   ./deploy/pi/setup.sh
   ```
   It asks for your password when it needs admin rights. Add `--dry-run` first if you'd like to
   see what it will do without changing anything.

That's it. The news pipeline is now running and will start by itself whenever the Pi boots.

## Everyday commands

```bash
journalctl -u jev-hft@news-live -f          # watch the live log (Ctrl-C to stop watching)
systemctl status jev-hft@news-live          # is it running?
sudo systemctl stop jev-hft@news-live       # stop it (pending records are saved first)
sudo systemctl restart jev-hft@news-live    # restart after changing .env or updating the code
npm run analyze:news -- data/decisions/news-*.jsonl   # read the results
```

To update the code later: `git pull`, then `sudo systemctl restart jev-hft@news-live`.

## Other programs

The same service can run the other parts of the project instead of, or next to, the news
pipeline:

```bash
./deploy/pi/setup.sh --service record    # save Coinbase market data around the clock (for backtests)
./deploy/pi/setup.sh --service record-binanceus  # save Binance.US's BTC/USD and BTC/USDT books and trades too
./deploy/pi/setup.sh --service live      # the market-data loop (needs TypeSafe credits; about $3 a day)
./deploy/pi/setup.sh --service dashboard # the live dashboard, to watch the Pi from another computer
```

Each runs as its own service (`jev-hft@record`, `jev-hft@record-binanceus`, `jev-hft@live`,
`jev-hft@dashboard`). Saving Coinbase's data writes about 180 MB a day, so use an SSD rather than the
SD card for that; Binance.US's is far smaller, since it trades much less.

## Watching it from your laptop

Run the dashboard as a second service and open it in a browser:

1. Add `DASHBOARD_HOST=0.0.0.0` to the Pi's `.env` (otherwise the page is only reachable from the
   Pi itself).
2. `./deploy/pi/setup.sh --service dashboard`
3. Open `http://<pi-address>:4000` on your laptop.

The dashboard is a separate program: the pipeline sends it one-way messages and never waits for
it, so running it costs the pipeline nothing, and stopping it changes nothing
([docs/dashboard.md](../../docs/dashboard.md)). The page has no password and can't control
anything, but anyone on your network can read it, so don't expose it to the internet.

## How the service behaves

- **Starts at boot,** once the network is up and the clock has synced. The clock matters because
  every timestamp the pipeline records depends on it.
- **Restarts itself** 10 seconds after a crash, and once a week to keep long runs fresh.
- **Saves before stopping:** a normal stop or restart lets it write its pending records first.
  A sudden power cut loses up to 30 minutes of pending news decisions.
- **Stays in its lane:** it runs as your user, can read the project folder, and can only write to
  the project's `data/` folder.
- **Notices dead connections:** on Wi-Fi especially, a connection can die without the Pi
  noticing. The pipeline checks for that itself and reconnects within about 10 seconds (Coinbase)
  or 40 seconds (Alpaca). Prices during the break are recorded as unknown, not as unchanged.
- **Logs go to the system journal**, so `journalctl` shows them even after a reboot.

Don't set `RUN_MINUTES` in `.env` for a service: the program would stop after that time and the
service would just start it again.

Don't run the same pipeline on the Pi and another computer at the same time. Alpaca's free plan
allows one connection per stream, X costs would double, and on a gateway account without credits
both copies would share the same few calls.

The status line printed every 30 seconds includes the running cost of Jev calls, so
`journalctl -u jev-hft@news-live | tail` shows what the service has spent since it started.
