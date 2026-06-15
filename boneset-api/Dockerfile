FROM node:20-alpine

WORKDIR /app

# Copy API package files and install production dependencies only
COPY boneset-api/package.json boneset-api/package-lock.json* ./
RUN npm ci --omit=dev

# Copy API source code
COPY boneset-api/ ./

EXPOSE 8000

CMD ["node", "server.js"]
