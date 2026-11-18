FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY core.js job.js ./
ENV NODE_ENV=production
USER node
CMD ["node","job.js"]
