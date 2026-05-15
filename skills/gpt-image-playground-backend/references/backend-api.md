# Backend API Reference

Base URL comes from `GIP_BACKEND_URL`.

Authentication:

```http
Authorization: Bearer <GIP_BACKEND_API_KEY>
```

Create job:

```http
POST /api/jobs
Content-Type: application/json
```

Body:

```json
{
  "prompt": "string",
  "params": {
    "size": "auto",
    "quality": "auto",
    "output_format": "png",
    "output_compression": null,
    "moderation": "auto",
    "n": 1
  },
  "inputImageDataUrls": [],
  "batch": false,
  "batchCount": 1
}
```

Poll:

```http
GET /api/jobs/{jobId}
```

Terminal statuses:

- `done`
- `error`
- `cancelled`

Successful result:

```json
{
  "job": {
    "status": "done",
    "result": {
      "images": ["data:image/png;base64,..."],
      "records": [
        {
          "id": "result_...",
          "outputUrl": "/api/gallery/result_.../image",
          "thumbnailUrl": "/api/gallery/result_.../thumbnail"
        }
      ]
    }
  }
}
```
