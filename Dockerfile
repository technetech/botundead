FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY harness.md ./harness.md
ENV NODE_ENV=production
ENV DATA_DIR=/data
CMD ["node", "src/main.js"]
