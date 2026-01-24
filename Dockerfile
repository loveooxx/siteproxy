# Stage 1: Build
FROM node:22-slim AS builder
WORKDIR /app

# Copy configuration and lockfile
COPY package*.json ./
COPY tsconfig.json ./

# Install all dependencies (including devDeps for tsc)
RUN npm install

# Copy source and build
COPY . .
RUN npm run build

# Stage 2: Production
FROM node:22-slim AS runner
WORKDIR /app

# Set production environment
ENV NODE_ENV=production

# Copy only production dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy compiled files from builder stage
COPY --from=builder /app/index.js ./

# Hono Node-Server default port
EXPOSE 5006

# Run using standard node (no tsx needed in prod)
CMD ["node", "index.js"]
