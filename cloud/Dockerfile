FROM node:22-alpine
WORKDIR /app
COPY cloud/package.json cloud/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY package.json ./
COPY src ./src
COPY cloud/server.js ./cloud/server.js
USER node
ENV NODE_ENV=production PORT=8080
CMD ["node", "cloud/server.js"]
