FROM node:22-alpine

# Install build dependencies for native modules and SQLite
RUN apk add --no-cache python3 make g++ sqlite

# Create app directory first
WORKDIR /app

# Create non-root user with specific UID/GID
RUN addgroup -g 1001 -S nodejs && \
    adduser -S botuser -u 1001 -G nodejs

# Copy package files and install dependencies as root (needed for native modules)
COPY package*.json ./
COPY tsconfig.json ./

# Install dependencies as root
RUN npm ci

# Copy application code
COPY . .

# Create data directory and set ownership
RUN mkdir -p /app/.data && \
    chown -R botuser:nodejs /app

# Create entrypoint script to fix permissions at runtime
RUN echo '#!/bin/sh' > /entrypoint.sh && \
    echo 'echo "🔧 Fixing permissions..."' >> /entrypoint.sh && \
    echo 'chown -R botuser:nodejs /app/.data' >> /entrypoint.sh && \
    echo 'chmod -R 775 /app/.data' >> /entrypoint.sh && \
    echo 'echo "✅ Permissions fixed, starting application..."' >> /entrypoint.sh && \
    echo 'exec su-exec botuser "$@"' >> /entrypoint.sh && \
    chmod +x /entrypoint.sh

# Install su-exec for better user switching
RUN apk add --no-cache su-exec

# Use entrypoint script
ENTRYPOINT ["/entrypoint.sh"]
CMD ["npx", "ts-node", "index.ts"]