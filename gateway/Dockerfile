FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY prisma.config.ts tsconfig.json tsconfig.build.json ./
COPY prisma ./prisma
COPY src ./src
RUN npx prisma generate && npx tsc -p tsconfig.build.json

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
# The prisma CLI stays out of production deps; install it standalone so the
# container can run `migrate deploy` on startup.
RUN npm ci --omit=dev && npm install --no-save prisma@7
COPY prisma.config.ts ./
COPY prisma ./prisma
COPY --from=build /app/dist ./dist
EXPOSE 3000
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server.js"]
