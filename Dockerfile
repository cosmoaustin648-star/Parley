# Multi-stage build for Parley. Not exercised in the environment this was written in
# (no Docker available there); `npm run build` + `npm start` inside it are.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci || npm install
COPY . .
RUN npm run build

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json* ./
RUN (npm ci --omit=dev || npm install --omit=dev) && npm cache clean --force
COPY --from=build /app/dist ./dist
RUN mkdir -p /app/data/uploads && chown -R node:node /app/data
USER node
ENV STORAGE_DIR=/app/data/uploads CLIENT_DIR=/app/dist/client
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
