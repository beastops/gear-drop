# Gear Drop — the whole thing: static client and rendezvous relay, one small image.
#
# Works as-is on Render, Railway, Fly.io, Koyeb and any other host that runs a container
# and allows WebSockets. `ws` is the only runtime dependency.
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

# Dependencies first, so a code change does not re-install them.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY server ./server
COPY web ./web

# Never run as root; nothing here needs it.
USER node
EXPOSE 3000

# Trust the platform's proxy header, since every one of these hosts terminates TLS in front
# of the container. Without it every client looks like it is on the same network.
ENV TRUST_PROXY=1

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
