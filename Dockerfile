FROM oven/bun:1.3-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app
COPY --chown=bun:bun package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY --chown=bun:bun src ./src
COPY --chown=bun:bun THIRD_PARTY_NOTICES.md ./
RUN bun -e "import { prepareSafetyModels } from './src/media/safety.ts'; import { prepareNudityModel } from './src/media/nudity.ts'; await prepareSafetyModels(); await prepareNudityModel();"
USER bun
EXPOSE 3000
CMD ["bun", "--smol", "src/index.ts"]
