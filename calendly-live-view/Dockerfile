FROM oven/bun:1.3.11-slim
WORKDIR /app
# Reading payment receipts: pdftotext for PDFs, tesseract OCR for photos and screenshots (English).
RUN apt-get update && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-eng poppler-utils \
  && rm -rf /var/lib/apt/lists/*
COPY . .
# The Railway volume at /data is owned by root; the stores write there.
USER root
EXPOSE 8080
CMD ["bun", "run", "src/server.ts"]
