# 批量模式前端优化 Phase 2 计划

## 采纳的 GLM 建议 + 进度条配色优化

### 1. DetailModal.tsx — 移动端优化

#### 1a. 图片区高度优化
- **位置**: 第323行
- **当前**: `className="md:w-1/2 w-full h-64 md:h-auto bg-gray-100 ..."`
- **目标**: `className="md:w-1/2 w-full h-56 sm:h-64 md:h-auto bg-gray-100 ..."`
- **原因**: 小屏幕（<640px）上 256px 图片区偏高，224px 更紧凑，给信息区更多空间

#### 1b. 操作按钮移动端 2列布局
- **位置**: 第714行
- **当前**: `className="grid grid-cols-4 sm:flex gap-2 pt-4 ..."`
- **目标**: `className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-4 ..."`
- **原因**: 4列按钮在移动端太挤，2列更易点击。桌面端保持4列

---

### 2. BatchDetailModal.tsx — 状态统计完善 + 交互优化

#### 2a. Header 添加 cancelledCount
- **位置**: 第164-166行之后
- **新增**: 
  ```tsx
  const cancelledCount = visibleTasks.filter((t) => t.status === 'cancelled' && !t.hiddenByRetry).length
  ```
- **Header 状态标签区域**（第182-199行之间）添加：
  ```tsx
  {cancelledCount > 0 && (
    <span className="flex items-center gap-1">
      <span className="w-1.5 h-1.5 rounded-full bg-orange-500" />
      {cancelledCount} 已取消
    </span>
  )}
  ```
- **原因**: 批量详情中显示已取消数量是完整的状态信息

#### 2b. BatchItemCard 添加 hover 效果
- **位置**: 第46行
- **当前**: `className={`flex items-center gap-3 rounded-2xl border p-3 transition ${...}`}`
- **目标**: 在 transition 后添加 `hover:shadow-sm hover:border-gray-300 dark:hover:border-white/20`
- **原因**: 轻微 hover 反馈提升交互体验，但不用 shadow-md（太突兀）

#### 2c. 进度条配色优化
- **位置**: 第216行
- **当前**: `bg-gradient-to-r from-blue-500 to-green-500`
- **目标**: `bg-gray-900 dark:bg-white`
- **原因**: 
  - 蓝→绿渐变与整体 UI 风格不匹配（整体使用黑白灰+微妙彩色点缀）
  - 黑色进度条在浅色模式下简洁有力，白色进度条在暗色模式下清晰醒目
  - 与整体"精致极简"的设计风格一致

---

### 3. GalleryPage.tsx — 移动端紧凑化

#### 3a. 移动端 line-clamp 优化
- **位置**: 第150行（桌面 hover overlay）和第155行（移动端下方）
- **当前**: `line-clamp-2`
- **目标**: 
  - 桌面 hover overlay 保持 `line-clamp-2`（空间充足）
  - 移动端下方改为 `line-clamp-1`（卡片空间有限）
- **原因**: 移动端卡片高度紧凑，单行截断避免卡片过高

---

### 4. 排除的 GLM 建议及原因

| 建议 | 排除原因 |
|------|---------|
| 1a. z-[55] → z-[60] | 内部二级弹窗已是 z-[60]，主 Modal 提至 z-[60] 会遮挡二级弹窗 |
| 2a. canViewDetail 包含 cancelled | cancelled 任务无结果可看，仅参数信息价值低，优先级不高 |
| 2d. 进度条纯色 bg-blue-500 | 蓝→绿渐变改为黑色/白色，更匹配整体极简风格 |
| 3. GalleryDetailModal 整文件替换 | 建议中的"目标版本"功能（onReuse 等）在对话历史中从未出现，是臆造的 |
| 4b. 传递 onReuse prop | GalleryPage 和 BackendGalleryRecord 不具备复用 API 配置所需信息 |
| 5a. 始终显示数量输入 | 违反已确认的设计：非 Codex CLI 批量模式下 n > 1 是单请求多图，不等价于子任务 |
| 5b/5c. 标签和描述修改 | "每批 N 张图"文案错误，批量模式下每个子任务生成 1 张图 |
| 6a. 移除 batchMode 下 n:1 覆盖 | **最危险**：会破坏"每个子任务生成 1 张图"的核心设计 |
| 7a/7b. TaskGrid 修改 | 超出本次优化范围，属于独立功能改进 |

---

## 执行顺序

1. **BatchDetailModal.tsx** — cancelledCount + hover + 进度条配色
2. **DetailModal.tsx** — 移动端图片高度 + 按钮布局
3. **GalleryPage.tsx** — 移动端 line-clamp
