FROM node:22-slim AS build

WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build

FROM node:22-slim AS runtime

ENV NODE_ENV=production \
    GATEWAY_HOME=/data

WORKDIR /app
COPY package.json ./
COPY --from=build /app/dist ./dist

RUN mkdir -p /data && chown -R node:node /data /app
USER node

VOLUME ["/data"]
# No EXPOSE: the gateway only makes outbound connections.
ENTRYPOINT ["node", "dist/index.js"]
CMD ["run"]
