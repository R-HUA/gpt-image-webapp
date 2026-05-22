# 批量模式前端优化方案

## 一、问题梳理

### 1.1 批量模式结果展示层级问题
- **现状**：`BatchDetailModal` 使用 `z-50`，`DetailModal` 也使用 `z-50`，子项点击"查看详情"时，`DetailModal` 与 `BatchDetailModal` 同级，由于 DOM 顺序关系，`DetailModal` 可能出现在 `BatchDetailModal` 下层。
- **影响**：用户在批量详情弹窗中点击子项的"查看详情"时，被批量弹窗遮挡，无法查看子任务详情。

### 1.2 批量模式失败结果无法查看详情
- **现状**：`BatchItemCard` 中，仅 `task.status === 'done'` 时显示"查看详情"按钮；`error` 状态不显示。
- **影响**：批量任务中的失败子项无法查看详情（如错误信息、参数等），与非批量模式不一致（非批量模式下失败任务也可以打开 `DetailModal` 查看完整信息）。

### 1.3 批量模式与数量 n 的逻辑不一致
- **现状**：`InputBar.tsx` 中，`!batchMode && (...)` 条件下才渲染数量输入框。当启用批量模式且无参考图时，数量 n 的输入框被隐藏，改为显示批量数输入框。
- **问题**：无参考图的批量模式本质上与非批量模式下 n > 1 是等价的（都是同一提示词生成多张图）。当前 UI 隐藏了 n 输入框，用户无法感知/调整原有的数量参数，造成困惑。
- **期望**：无参考图的批量模式不应改变数量 n 的显示逻辑，而是继续使用原有的 n 参数（或明确批量模式与 n 参数的关系）。即：无参考图时启用批量模式，UI 上不应有变化（不额外显示批量数量输入框）。

### 1.4 批量模式 UI 与整体风格不统一
- **现状**：
  - `BatchDetailModal` 使用 `rounded-t-2xl sm:rounded-2xl`、`bg-gray-50 dark:bg-gray-950` 等样式，与 `DetailModal` 的 `rounded-3xl`、`backdrop-blur-xl`、`bg-white/90 dark:bg-gray-900/90` 风格差异较大。
  - `BatchDetailModal` 的头部、进度条、列表项的圆角、阴影、边框风格与主应用不一致。
  - 批量堆叠卡片（`batch-stack-wrapper`）的阴影效果在暗色模式下视觉层次不够清晰。
- **影响**：批量模式看起来像是一个"外挂"功能，缺乏整体感。

### 1.5 Gallery 查看详情占满全屏
- **现状**：`GalleryPage.tsx` 中的 `GalleryLightbox` 使用 `fixed inset-0 z-50 bg-black/95 backdrop-blur-md flex flex-col`，是一个全屏覆盖的 Lightbox。
- **问题**：
  - 与生图界面的 `DetailModal`（弹出框形式，左右分栏）不一致。
  - 全屏覆盖导致用户无法同时看到 Gallery 列表，浏览体验不佳。
  - 底部信息面板固定占用空间，图片显示区域被压缩。
- **期望**：Gallery 查看详情应使用与 `DetailModal` 类似的弹出框形式，左右分栏（左侧图片、右侧信息），保持交互一致性。

### 1.6 移动端适配可优化
- **现状**：
  - `BatchDetailModal` 在移动端使用 `items-end`，从底部弹出，高度为 `max-h-[85vh]`，但未完全适配安全区域。
  - `GalleryLightbox` 的底部信息面板在移动端可能遮挡内容。
  - `InputBar` 的移动端折叠区域（`collapse-section`）在批量模式下参数区域折叠后，批量相关信息显示不够紧凑。
- **可优化点**：
  - 增加 `safe-area-bottom` 适配。
  - Gallery 弹出框在移动端改为全屏或底部 sheet 形式。
  - 批量模式在移动端的参数布局优化。

---

## 二、整体设计优化方案

### 2.1 批量模式结果展示层级修复

**方案**：提升 `DetailModal` 的 z-index，或调整 `BatchDetailModal` 内嵌 `DetailModal` 的渲染方式。

**具体实现**：
- 方案 A（推荐）：`DetailModal` 的 z-index 从 `z-50` 提升到 `z-[55]` 或更高，确保在 `BatchDetailModal` (z-50) 之上。
- 方案 B：`BatchDetailModal` 内部点击"查看详情"时，先关闭 `BatchDetailModal`，再打开 `DetailModal`（体验不佳，不推荐）。

**实现位置**：`src/components/DetailModal.tsx` 第 303 行，将 `z-50` 改为 `z-[55]`。

### 2.2 批量模式失败结果支持查看详情

**方案**：`BatchItemCard` 中，对 `error` 状态的子项也显示"查看详情"按钮。

**具体实现**：
- 修改 `BatchDetailModal.tsx` 第 98-105 行：
  ```tsx
  // 原代码：仅 done 状态可查看详情
  {task.status === 'done' && (
    <button onClick={() => setDetailTaskId(task.id)}>...</button>
  )}
  
  // 修改为：done 和 error 状态均可查看详情
  {(task.status === 'done' || task.status === 'error') && (
    <button onClick={() => setDetailTaskId(task.id)}>...</button>
  )}
  ```
- 同时，在 `DetailModal` 中，批量子项（`batchId` 存在）的详情展示需要适配：
  - 批量子项的 `outputImages` 可能为空（失败时），`DetailModal` 左侧图片区域需要处理空状态。
  - 已处理：`DetailModal` 第 324 行 `task.status === 'done' && outputLen > 0 && currentOutputPreviewSrc` 已经处理了无图情况，会显示错误状态面板。

### 2.3 批量模式与数量 n 的逻辑统一

**方案**：无参考图时，批量模式不应隐藏数量 n 的输入框，也不应额外显示批量数量输入框。

**具体实现**：
- 修改 `InputBar.tsx` 中批量模式的 UI 逻辑：
  - 移除"无参考图时显示批量数输入框"的特殊逻辑。
  - 批量模式开启时，始终显示原有的"数量 n"输入框（因为批量模式本质上就是 n > 1 的另一种表现形式）。
  - 如果存在参考图，批量模式的数量由参考图数量决定（此时 n 输入框可禁用或隐藏，因为数量已确定）。
  - 如果无参考图，批量模式的数量由 n 参数决定（不额外显示批量数输入框）。

**代码调整**：
- 桌面端（~1876-1891 行）和移动端（~1971-1980 行）的批量数量输入框逻辑，仅在 `batchMode && !serverImageBatchMode && inputImages.length > 0` 时隐藏 n 输入框（因为数量由图片数决定）。
- 无参考图时，`batchMode` 开启不隐藏 n 输入框，也不显示额外的 `batchCount` 输入框。

### 2.4 批量模式 UI 风格统一

**方案**：将 `BatchDetailModal` 的视觉风格与 `DetailModal` 对齐。

**具体调整**：
1. **背景与边框**：
   - 将 `BatchDetailModal` 的外层容器从 `bg-gray-50 dark:bg-gray-950` 改为 `bg-white/90 dark:bg-gray-900/90 backdrop-blur-xl border border-white/50 dark:border-white/[0.08] rounded-3xl`。
   - 与 `DetailModal` 保持一致的使用 `shadow-[0_8px_40px_rgb(0,0,0,0.12)] dark:shadow-[0_8px_40px_rgb(0,0,0,0.4)]`。

2. **头部样式**：
   - 头部背景改为透明或统一使用 `bg-white dark:bg-gray-900`，与 `DetailModal` 的头部保持一致。
   - 关闭按钮使用与 `DetailModal` 相同的样式。

3. **列表项卡片**：
   - `BatchItemCard` 的圆角从 `rounded-xl` 统一为 `rounded-2xl`。
   - 边框颜色统一使用 `border-gray-200 dark:border-white/[0.08]`。
   - 状态标签的样式与 `TaskCard` 中的标签风格对齐。

4. **进度条**：
   - 进度条增加 `rounded-full`，与整体圆角风格一致。
   - 使用更柔和的颜色过渡。

5. **批量堆叠卡片阴影**：
   - 优化暗色模式下的 `batch-stack-shadow` 背景色，增加层次感。
   - 考虑增加微妙的边框高亮。

### 2.5 Gallery 查看详情改为弹出框

**方案**：将 `GalleryLightbox` 从全屏 Lightbox 改为与 `DetailModal` 类似的弹出框（Modal）。

**具体实现**：
1. **新建组件或复用 `DetailModal`**：
   - 方案 A（推荐）：复用 `DetailModal`，但需要支持从 `BackendGalleryRecord` 加载数据。
   - 方案 B：新建 `GalleryDetailModal` 组件，结构与 `DetailModal` 类似，左侧图片、右侧信息。

2. **弹出框结构**：
   - 外层：`fixed inset-0 z-50 flex items-center justify-center p-4`（与 `DetailModal` 一致）。
   - 遮罩：`absolute inset-0 bg-black/20 dark:bg-black/40 backdrop-blur-md`。
   - 内容区：`max-w-4xl w-full max-h-[90vh] overflow-hidden flex flex-col md:flex-row`。
   - 左侧：图片展示区（支持 Lightbox 放大查看）。
   - 右侧：信息区（提示词、参数、模型、时间、操作按钮）。

3. **交互优化**：
   - 左右箭头切换上一个/下一个 Gallery 记录（与当前 `GalleryLightbox` 的导航一致）。
   - 点击图片可进入 `Lightbox` 放大查看。
   - 支持键盘左右切换、ESC 关闭。

4. **移动端适配**：
   - 移动端改为垂直布局（图片在上，信息在下），或全屏底部 sheet 形式。

### 2.6 移动端适配优化

1. **BatchDetailModal 移动端**：
   - 增加 `safe-area-bottom` padding：`pb-[max(1rem,var(--safe-area-bottom))]`。
   - 底部操作区域增加安全区域适配。

2. **GalleryDetailModal 移动端**：
   - 图片区域高度限制为 `50vh`，信息区域可滚动。
   - 或采用底部 sheet 形式（`rounded-t-2xl` 从底部滑出）。

3. **InputBar 移动端批量模式**：
   - 批量模式说明文字在移动端换行显示，避免截断。
   - 参数网格在移动端保持 `grid-cols-2`，确保可点击区域足够大。

4. **TaskCard 移动端**：
   - 批量堆叠卡片的角标在移动端缩小字体，避免遮挡。
   - 侧滑选择手势的触发阈值在移动端适当增大，避免误触。

---

## 三、实施步骤

### Phase 1: 核心功能修复（高优先级）
1. **修复 DetailModal z-index**：`DetailModal` 提升为 `z-[55]`。
2. **批量失败项支持查看详情**：`BatchItemCard` 中 `error` 状态也显示"查看详情"。
3. **批量模式数量逻辑统一**：`InputBar` 中无参考图时不隐藏 n 输入框，不显示额外 batchCount 输入框。

### Phase 2: UI 风格统一（中优先级）
4. **BatchDetailModal 风格重构**：对齐 `DetailModal` 的视觉风格（背景、边框、圆角、阴影）。
5. **批量堆叠卡片阴影优化**：暗色模式层次感增强。

### Phase 3: Gallery 重构（中优先级）
6. **Gallery 详情改为弹出框**：新建/复用 Modal 组件替换全屏 Lightbox。
7. **Gallery 弹出框导航**：支持左右切换、键盘事件。

### Phase 4: 移动端适配（低优先级）
8. **安全区域适配**：`safe-area-bottom`、`safe-area-top` 全面检查。
9. **移动端布局微调**：`BatchDetailModal`、`GalleryDetailModal`、`InputBar` 移动端布局优化。

---

## 四、文件变更清单

| 文件 | 变更类型 | 变更内容 |
|------|---------|---------|
| `src/components/DetailModal.tsx` | 修改 | z-index 提升为 `z-[55]` |
| `src/components/BatchDetailModal.tsx` | 修改 | 失败项查看详情、UI 风格统一 |
| `src/components/InputBar.tsx` | 修改 | 批量模式数量逻辑统一 |
| `src/components/GalleryPage.tsx` | 修改 | GalleryLightbox 改为 Modal 形式 |
| `src/index.css` | 修改 | 批量堆叠阴影优化、安全区域适配 |
| `src/components/TaskGrid.tsx` | 可选修改 | 批量堆叠卡片角标移动端适配 |

---

## 五、验收标准

1. 在批量详情弹窗中点击任意子项（包括失败项）的"查看详情"，`DetailModal` 正确显示在批量弹窗之上。
2. 批量模式无参考图时，数量 n 输入框正常显示，无额外的"批量数"输入框。
3. `BatchDetailModal` 的视觉风格（背景模糊、圆角、边框）与 `DetailModal` 基本一致。
4. Gallery 中点击图片打开的是弹出框（Modal），而非全屏 Lightbox；弹出框内可查看图片和详细信息，支持左右切换。
5. 移动端各弹窗底部有安全区域留白，无内容被遮挡。
