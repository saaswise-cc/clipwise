# syntax=docker/dockerfile:1.7

# ---- base: shared node + workdir ----
FROM node:20-bookworm-slim AS base
WORKDIR /app
ENV NODE_ENV=development \
    npm_config_update_notifier=false \
    npm_config_fund=false

# ---- deps: install all deps (incl. dev) once, cached on package files ----
FROM base AS deps
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

# ---- dev: run tsx watch; source is bind-mounted by compose ----
FROM deps AS dev
COPY tsconfig.json ./
COPY src ./src
EXPOSE 3000
CMD ["npm", "run", "dev"]

# ---- build: compile TS to dist/ ----
FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- prod-deps: production-only node_modules ----
FROM base AS prod-deps
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev

# ---- prod: minimal runtime image ----
FROM node:20-bookworm-slim AS prod
WORKDIR /app
ENV NODE_ENV=production \
    npm_config_update_notifier=false \
    npm_config_fund=false
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
