# Backend API Reference

Base URL comes from `GIP_BACKEND_URL`.

Use a backend access token created in Settings > Admin. This is not the upstream image provider API key.

Authentication:

```http
Authorization: Bearer <GIP_BACKEND_ACCESS_TOKEN>
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
  "batchCount": 1,
  "serverImagePath": ""
}
```

`serverImagePath` is administrator-only. The backend rejects it for normal users and also rejects paths that do not match the server image path saved in Settings > Admin.

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
