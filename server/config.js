export const serverConfig = {
  host: process.env.GIP_HOST || '0.0.0.0',
  port: Number(process.env.GIP_PORT || 4173),
  dataDir: process.env.GIP_DATA_DIR || './server-data',
  outputDir: process.env.GIP_OUTPUT_DIR || './server-data/output',
  thumbnailDir: process.env.GIP_THUMBNAIL_DIR || './server-data/thumbnails',
  batchUploadDir: process.env.GIP_BATCH_UPLOAD_DIR || './server-data/batch-uploads',
  admin: {
    username: 'admin',
    password: 'admin123456',
  },
}
