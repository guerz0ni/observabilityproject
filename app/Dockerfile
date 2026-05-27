FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY app.js ./

RUN mkdir -p /app/data && chown -R node:node /app

EXPOSE 3000

USER node

CMD ["node", "app.js"]
