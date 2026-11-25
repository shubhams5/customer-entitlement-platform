FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run prisma:generate && npm run build

RUN mkdir -p /data && chown -R node:node /app /data
USER node

ENV NODE_ENV=production
EXPOSE 3000

CMD ["npm", "run", "start:prod"]
