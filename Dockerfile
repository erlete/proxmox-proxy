FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY panel/package.json panel/package-lock.json panel/
RUN npm ci --no-fund --no-audit && npm ci --prefix panel --no-fund --no-audit
COPY . .
RUN npm run build && npm run build --prefix panel

FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-fund --no-audit && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/panel/dist ./panel/dist
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080 8081
CMD ["node", "dist/index.js"]
