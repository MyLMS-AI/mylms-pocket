FROM node:22-alpine
WORKDIR /app
COPY package.json server.mjs ./
COPY public ./public
ENV NODE_ENV=production
ENV PORT=3090
EXPOSE 3090
CMD ["node", "server.mjs"]
