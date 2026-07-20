FROM node:24-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server.js ./
COPY public ./public
ENV NODE_ENV=production PORT=4173 HOST=0.0.0.0
EXPOSE 4173
USER node
CMD ["node", "server.js"]
