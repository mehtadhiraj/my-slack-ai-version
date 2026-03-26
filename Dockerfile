FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --production

COPY src/ ./src/
COPY data/ ./data/

EXPOSE 3000

CMD ["npm", "start"]
