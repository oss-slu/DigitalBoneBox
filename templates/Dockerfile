FROM node:20-alpine

WORKDIR /app

# Copy package files and install only the http-server dependency
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy static frontend assets
COPY templates/ ./templates/
COPY .vscode/ ./.vscode/ 2>/dev/null || true

EXPOSE 8080

# Serve the app on port 8080 with no caching
CMD ["npx", "http-server", "-c-1", "-p", "8080", "--proxy", "http://localhost:8080?"]
