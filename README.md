# EQ · WATCH — Live Global Seismic Monitor

A dark, mission-control style dashboard that plots real-time earthquake
activity from the USGS on a draggable, zoomable globe, with a live
stats panel, an event feed, a tsunami-advisory banner, and an animated
seismograph ticker.

It does two independent things, both driven by the same code:

1. **A normal website**, deployed to GitHub Pages.
2. **A 24/7 YouTube live stream** of that same dashboard, rendered
   headlessly and pushed out via GitHub Actions — no server to rent.

## 1. The website

Static site: `index.html` + `assets/app.js` + `assets/style.css` +
`data/`. No build step.

### How the data works

The dashboard reads three official USGS feeds:

| Feed | Source |
|---|---|
| Past Hour, M2.5+ | `.../feed/v1.0/summary/2.5_hour.geojson` |
| Past Day, M2.5+ | `.../feed/v1.0/summary/2.5_day.geojson` |
| Past Day, M4.5+ | `.../feed/v1.0/summary/4.5_day.geojson` |

On load (and every 60s after), the browser fetches these **directly**
— USGS's feeds are CORS-enabled. If that fails, it falls back to the
cached copies in `data/hour.json` / `day.json` / `major.json`, which
`sync-data.yml` re-fetches and commits every 10 minutes. The status
pill in the header shows which mode is active: **Live · USGS**,
**Cached snapshot**, or **Feed unavailable**.

A red **tsunami advisory bar** appears automatically if any quake in
the current feed carries USGS's `tsunami: 1` flag.

### Deploying to GitHub Pages

1. Push this repo to GitHub.
2. Settings → Pages → Source → **GitHub Actions**.
3. `deploy.yml` publishes on every push to `main` (and can be run
   manually). `sync-data.yml` keeps the fallback data fresh on its own
   cron — no secrets needed for either.

## 2. The YouTube live stream

`docker/` contains a container that:

1. Starts a virtual display (**Xvfb**).
2. Serves the dashboard over local `http://` (needed for `fetch()` —
   `file://` won't work) via a tiny Python server.
3. Launches real, on-screen **Chromium** (via Puppeteer, kiosk mode)
   pointed at that local URL — this is a genuine browser tab loading
   the live dashboard, not a screenshot.
4. Runs **ffmpeg** with `x11grab` to capture that display and push it
   straight to YouTube's RTMP ingest, exactly like OBS would.

Because it's a real browser tab, the globe keeps rotating, the
seismograph ticker keeps animating, and the dashboard keeps polling
USGS live — the stream is the actual dashboard, not a recording of it.

### Required GitHub secret

| Secret | Required? | What it's for |
|---|---|---|
| `YOUTUBE_STREAM_KEY` | **Yes** | YouTube Studio → Go Live → Stream → "Stream key". `docker/start.sh` refuses to start without it. |
| `AUDIO_URL` | No | Optional background audio track(s), comma-separated, looped for the whole stream. Without it, the stream uses a silent audio track (YouTube requires *some* audio stream). |

Add secrets: repo **Settings → Secrets and variables → Actions → New
repository secret**.

### Staying live past GitHub's 6-hour job limit

Three workflows work together, same pattern as a standard 24/7
Actions-based stream setup:

| Workflow | Trigger | Job |
|---|---|---|
| `stream.yml` | manual, or cron every 6h | Builds/pulls the image and runs it for up to 6h, pushing to YouTube |
| `restart-stream.yml` | fires when `stream.yml` finishes | Immediately queues the next run (cached image, no rebuild) |
| `stream-watchdog.yml` | cron every 5 min | Safety net — starts a run if none is active or queued |

You only trigger **`stream.yml`** manually, once:

1. Add `YOUTUBE_STREAM_KEY` as a secret.
2. Actions tab → **Stream Dashboard to YouTube** → **Run workflow**
   (leave `auto_restart` unchecked — that forces a fresh image build).
3. Done. `restart-stream.yml` and `stream-watchdog.yml` keep it
   looping from here.

To stop the stream: disable `stream-watchdog.yml` and
`restart-stream.yml` in the Actions tab, then cancel any in-progress
`stream.yml` run.

### Tuning

Passed as env vars in `stream.yml`'s `docker run` step (or in `.env`
for local testing):

| Var | Default | Notes |
|---|---|---|
| `STREAM_WIDTH` / `STREAM_HEIGHT` | `1280` / `720` | Higher costs more CPU on a 2-core Actions runner |
| `STREAM_FPS` | `24` | Lower this if the stream looks choppy under CI load |

### Running locally before you push

```bash
cp .env.example .env
# edit .env with your real YOUTUBE_STREAM_KEY
docker compose up --build
```

## File structure

```
.
├── index.html
├── assets/
│   ├── style.css
│   └── app.js
├── data/
│   ├── countries.min.geojson   (basemap, simplified from your upload)
│   ├── hour.json / day.json / major.json   (kept fresh by sync-data.yml)
├── docker/                      # YouTube-streaming container
│   ├── Dockerfile
│   ├── start.sh                 # Xvfb + http server + Chromium + ffmpeg
│   ├── render.js                # Puppeteer: launches Chromium in kiosk mode
│   └── package.json
├── docker-compose.yml           # local stream testing
├── .env.example
└── .github/workflows/
    ├── deploy.yml                # publishes the website to GitHub Pages
    ├── sync-data.yml             # refreshes data/*.json every 10 min
    ├── stream.yml                # builds/runs the YouTube stream (run this)
    ├── restart-stream.yml        # re-queues stream.yml on completion
    └── stream-watchdog.yml       # starts a run if none is active
```
