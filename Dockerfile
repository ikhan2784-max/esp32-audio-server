FROM node:20-alpine

WORKDIR /app

# Install dependencies first for better layer caching
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application code
COPY . .

# Fly.io sets PORT env var
ENV PORT=8080
EXPOSE 8080

# Run as non-root user for security
USER node

CMD ["node", "server.js"]
