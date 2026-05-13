FROM mcr.microsoft.com/playwright:v1.52.0-noble

WORKDIR /app

# Copy package files and install dependencies
COPY package.json ./
RUN npm install --omit=dev

# Playwright browsers are pre-installed in the base image
# but we need to make sure chromium is available
RUN npx playwright install chromium --with-deps || true

# Copy application code
COPY index.js ./

# Expose port (Railway sets $PORT automatically)
EXPOSE 3000

CMD ["node", "index.js"]
