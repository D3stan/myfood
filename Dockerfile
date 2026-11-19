# syntax=docker/dockerfile:1
FROM node:26-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
# tsc in `npm run build` also typechecks tests/ and scripts/, so the whole context is needed.
COPY . .
ARG BUILD_ID
ENV BUILD_ID=$BUILD_ID
RUN npm run build

FROM node:26-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATA_DIR=/data JOBS_DIR=/tmp/jobs WEB_DIR=/app/dist/web TZ=Europe/Copenhagen AI_PROVIDER=openai
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY --from=build /app/dist/web ./dist/web
RUN mkdir /data && chown node:node /data
USER node
HEALTHCHECK CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "src/server/main.ts"]
