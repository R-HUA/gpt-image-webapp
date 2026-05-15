# Docker Compose 后端模式部署说明

本文档适用于当前后端化分支：后端直接托管编译后的前端，不需要 nginx。浏览器只访问本项目后端，真实图片服务商请求由后端统一发起。

## 1. 准备环境

服务器需要安装：

```bash
docker --version
docker compose version
```

把项目代码放到服务器，例如：

```bash
git clone <your-repo-url> gpt_image_playground
cd gpt_image_playground
git checkout codex/backend-auth-gallery
```

## 2. 需要重点修改的配置

Compose 文件在：

```text
deploy/docker-compose.backend.yml
```

常用配置：

```yaml
ports:
  - "4173:4173"
```

左侧 `4173` 是宿主机端口。如果服务器已有占用，可改成：

```yaml
ports:
  - "8080:4173"
```

数据持久化目录：

```yaml
volumes:
  - ./server-data:/data
```

`./server-data` 会保存：

- `db.json`：用户、后端访问令牌、管理配置、审计日志、图库元数据
- `output/`：按用户名分类保存的生成原图
- `thumbnails/`：后端压缩生成的 WebP 缩略图
- `batch-uploads/`：批量上传的输入图片备份

如果要让管理员使用“服务器图片目录”批量图生图，额外挂载一个只读目录：

```yaml
volumes:
  - ./server-data:/data
  - /absolute/host/input-images:/input-images:ro
```

然后管理员后台里把服务器图片目录设置为：

```text
/input-images
```

## 3. 启动

在项目根目录执行：

```bash
docker compose -f deploy/docker-compose.backend.yml up -d --build
```

查看日志。后端会输出 JSON 行日志，包含任务入队、开始执行、上游服务商请求、图片落盘、缩略图生成和错误堆栈：

```bash
docker compose -f deploy/docker-compose.backend.yml logs -f
```

访问：

```text
http://<服务器IP>:4173
```

默认管理员写死在 `server/config.js`：

```text
用户名：admin
密码：admin123456
```
该默认密码只在首次初始化数据文件时写入；已有 `server-data/db.json` 后，容器重启不会重置管理员密码。

首次登录后打开“设置”，进入“管理员”子菜单，至少配置：

- 上游服务商 Base URL：例如 `https://api.openai.com/v1`
- 上游服务商密钥：真实图片服务商 Key
- 模型：例如 `gpt-image-2`
- 总体并发数：默认 `2`
- 服务器图片目录：可选，仅管理员批量使用服务器目录图片时需要

服务器图片目录只允许管理员使用。后端会校验任务请求中的目录必须等于后台保存的目录，并且只读取该目录下的图片文件，不读取子目录。

## 4. 创建普通用户和后端访问令牌

在“设置 > 管理员”界面：

1. 新增普通用户，普通用户无注册入口。
2. 在“后端访问令牌”区域新增令牌。
3. 复制刚生成的完整 token；它只在创建时完整显示。

这个令牌用于外部程序或项目内 skill 直接调用本项目后端，不是上游服务商密钥：

```http
Authorization: Bearer <后端访问令牌>
```

## 5. 更新部署

拉取新代码后：

```bash
git pull
docker compose -f deploy/docker-compose.backend.yml up -d --build
```

不需要删除 `server-data`，否则会丢失用户、配置、图库和审计日志。

管理员在设置中删除“批量上传原图”只会删除上传备份，不会删除已经生成的结果图。

## 6. 备份

建议定期备份：

```bash
tar -czf gpt-image-playground-backup-$(date +%F).tar.gz deploy/server-data
```

如果你把持久化目录改到了别的位置，请备份实际挂载的宿主机目录。

## 7. 常见问题

### 端口访问不了

检查容器：

```bash
docker compose -f deploy/docker-compose.backend.yml ps
docker compose -f deploy/docker-compose.backend.yml logs --tail=100
```

检查服务器防火墙是否放行宿主机端口，例如 `4173`。

### sharp 安装或运行失败

当前后端用 `sharp` 生成真实压缩 WebP 缩略图。Compose 使用 `node:20-bookworm-slim`，通常不需要额外系统包。如果你换成 Alpine 镜像，需要重新验证 `sharp` 原生依赖。

### 管理员服务器图片目录读不到图片

确认目录已挂载到容器内，并且后台填写的是容器内路径，例如 `/input-images`，不是宿主机路径。

### 如何停服

```bash
docker compose -f deploy/docker-compose.backend.yml down
```
