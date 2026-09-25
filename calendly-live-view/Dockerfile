FROM oven/bun:1.3.11-slim
WORKDIR /app
COPY . .
# The Railway volume at /data is owned by root; the stores write there.
USER root
EXPOSE 8080
CMD ["bun", "run", "src/server.ts"]
