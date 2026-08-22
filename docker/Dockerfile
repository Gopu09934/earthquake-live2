# Build context is the repo root (see .github/workflows/stream.yml),
# so this Dockerfile can pull in index.html / assets / data directly.

FROM node:20-bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive

# ffmpeg          — captures the virtual display and pushes to YouTube
# xvfb            — virtual X display for Chromium to render into
# python3         — serves the static dashboard over http:// (fetch()
#                    of local JSON needs a real origin, not file://)
# the lib* packages below are what Chromium needs to actually launch
# inside a minimal Debian container — without them it fails to start.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    xvfb \
    python3 \
    ca-certificates \
    fonts-liberation \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libatspi2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Node deps (this also downloads Puppeteer's bundled Chromium,
# which — unlike Ubuntu/Debian's own "chromium" package — actually
# works standalone inside a container).
COPY docker/package.json ./
RUN npm install --omit=dev

COPY docker/start.sh docker/render.js ./
RUN chmod +x start.sh

# Bake the dashboard itself in as the site Chromium will load.
COPY index.html ./site/index.html
COPY assets ./site/assets
COPY data ./site/data

CMD ["./start.sh"]
