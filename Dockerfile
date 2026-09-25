FROM node:22-alpine
RUN apk add --no-cache git
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
COPY api ./api
COPY assets ./assets
COPY stores ./stores
COPY data/gallery-manifest.json ./data/
# data/index.json is a build artifact derived from stores/, not a committed file,
# so generate it in the image instead of copying it in.
RUN node src/ingest.js
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
CMD ["node", "src/server.js"]
