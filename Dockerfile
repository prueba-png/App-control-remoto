# Servidor de señalización (server.js). Despliega esto en cualquier host que
# ejecute contenedores/Node: Render, Railway, Fly.io, etc.
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server.js ./
COPY public ./public
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
