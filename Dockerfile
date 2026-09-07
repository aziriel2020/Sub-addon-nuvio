FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY server.js ./
COPY src ./src
ENV PORT=7001
EXPOSE 7001
CMD ["node", "server.js"]
