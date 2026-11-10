FROM node:22-alpine AS build
WORKDIR /app/services/rg-tools
COPY services/rg-tools/package*.json ./
RUN npm ci
COPY services/rg-tools/ ./
RUN npm run build

FROM node:22-alpine
ENV NODE_ENV=production RG_ROOT=/app
WORKDIR /app/services/rg-tools
COPY services/rg-tools/package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/services/rg-tools/dist ./dist
COPY contracts /app/contracts
COPY prompts /app/prompts
COPY config /app/config
COPY sandbox /app/sandbox
EXPOSE 8080
CMD ["node", "dist/src/main.js"]
