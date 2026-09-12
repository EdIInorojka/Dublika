FROM node:22-bookworm-slim

# Demucs is used only on the server to remove the original dialogue while
# retaining music/effects. ffmpeg itself is supplied by the linux build of
# ffmpeg-static from package-lock.json.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-venv python3-pip ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build:vercel \
  && npm prune --omit=dev \
  && python3 -m venv /opt/demucs \
  && /opt/demucs/bin/pip install --no-cache-dir demucs

ENV NODE_ENV=production \
    DUBLIKA_HOST=0.0.0.0 \
    DUBLIKA_DEMUCS_PYTHON=/opt/demucs/bin/python

EXPOSE 8788

CMD ["node", "server/local-server.mjs"]
