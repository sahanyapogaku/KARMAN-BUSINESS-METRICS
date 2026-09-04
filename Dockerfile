FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV PORT=4100
EXPOSE 4100

CMD ["node", "server.js"]
