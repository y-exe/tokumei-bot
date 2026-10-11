FROM oven/bun:1.3-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --chown=bun:bun package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY --chown=bun:bun src ./src
USER bun
EXPOSE 3000
CMD ["bun", "--smol", "src/index.ts"]
