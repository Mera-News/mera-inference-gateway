# syntax=docker/dockerfile:1

# Stage 1: Build (all deps + compile)
FROM node:20-alpine AS builder
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Stage 2: Prune dev deps from existing install
FROM builder AS deps
RUN npm prune --omit=dev

# Stage 3: Runtime
FROM node:20-alpine
WORKDIR /usr/src/app
RUN addgroup -g 1001 -S nodejs && adduser -S nestjs -u 1001
COPY --from=builder /usr/src/app/dist ./dist
COPY --from=deps /usr/src/app/node_modules ./node_modules
COPY --from=builder /usr/src/app/package*.json ./
USER nestjs
EXPOSE 8080
CMD ["node", "dist/main"]
