# BananaDecompose

用 **Nano Banana 2**（`google/gemini-3.1-flash-image`，走 OpenRouter）生成图像，并把它变成**可编辑的图层 + 真实可改的文字**。

两条管线做进同一个工作台，可随时切换、可并排对比：

| | A · 生成即分层 | B · 事后拆解 |
|---|---|---|
| 思路 | 先规划结构，元素逐个独立渲染，文字全程不进像素 | 先出一张拍平的成品，再把它拆回图层 |
| 可编辑性 | **设计出来的** —— 文字是真文本节点，图层天生独立 | **抢救出来的** —— 文字靠 OCR，图层靠分割 + 重绘补洞 |
| 精度上限 | 无损（元素本来就没合过） | 约 PSNR 26 / LPIPS 0.09，视觉可用但非像素级 |
| 能处理外来图 | ❌ 只能编辑本系统生成的 | ✅ 可以上传任意平图 |
| 依赖 | 纯 API | 纯 API |

**为什么两条都做**：A 是正确答案，B 是唯一能处理"别人给的一张图"的路。把它们放进同一个对比框里，差距是能被量化出来的，而不是靠嘴说。

## 快速开始

```bash
npm install
cp .env.local.example .env.local   # 填入 OPENROUTER_API_KEY
npm run dev
```

打开 http://localhost:3000 。

不填 key 也可以打开 **http://localhost:3000/selftest** —— 抠图算法的自检页，用已知 alpha 的合成图验证数学，不消耗任何 API。

## 部署到 Vercel

直接 import 仓库即可。唯一必须配的环境变量是 `OPENROUTER_API_KEY`。

架构上专门为 serverless 做了让步：**每个 API route 只做一次模型调用**，多步编排全部放在浏览器里。所以没有任何一个函数会逼近 Vercel Hobby 的 60s 上限，也不需要队列或后端状态。

## 关键设计决策

### 1. Nano Banana 不输出 alpha —— 这是绕不开的硬约束

Gemini 系图像模型（Nano Banana / Pro / 2）**全都只输出不带 alpha 通道的 RGB**。要求"透明背景"，拿到的是纯白、纯黑，或者画上去的马赛克格子。

所以透明是**算出来的**，四种策略在 UI 里可切：

| 策略 | 做法 | 成本 | 自检实测 |
|---|---|---|---|
| **双渲染差值** | 白底 + 黑底各生成一次，解 `α = 1 − (C_white − C_black)`，`色值 = C_black / α` | 2× | 平均 alpha 误差 **0.10%** |
| 色键抠图 | 在纯品红底上生成一次，按色距抠除 + 去色溢 | 1× | 平均 alpha 误差 **4.17%**，软边有明显品红边 |
| VLM 分割掩码 | 灰底生成一次 + Gemini 返回 segmentation mask | 1× + 1 视觉调用 | 取决于 grounding 质量 |
| 原生透明 | 直接请求 `background=transparent` | 1× | 对照组，Gemini 系预期失败 |

数字来自 `/selftest`：真值是带羽化边缘的圆盘 + 45% 半透明横条，专挑软边和半透明两种最难的情况。**注意这是算法上限** —— 自检里两张底片像素级一致，真实模型两次生成会有漂移，实际误差更大。

所有像素运算都在浏览器 canvas 里跑（`lib/matte.ts`），服务端不碰图像数据。

### 2. 文字永远不烘焙进像素

管线 A 的核心。规划阶段就把文案单独拎出来，出图 prompt 里明确要求"不要画任何文字、给文字留白"，最终文字用真实 DOM 文本节点渲染。

结果：改字、换字体、换语言全都是零损耗的，导出的 SVG 里文字是 `<text>` 节点而不是描边路径。**这是整个 demo 的验收标准。**

对照组 `文字策略 = 烘焙后回收` 会走完整的 OCR → 擦除 → 重排流程，用来量化"事后回收"到底掉多少精度。

### 3. 模型分三个槽

| 槽 | 默认 | 干什么 |
|---|---|---|
| `OPENROUTER_IMAGE_MODEL` | `google/gemini-3.1-flash-image` | 出图、编辑、擦除重绘 |
| `OPENROUTER_VISION_MODEL` | `google/gemini-3.7-flash` | 规划 Scene JSON、读版面、OCR |
| `OPENROUTER_GROUNDING_MODEL` | `google/gemini-3.1-pro-preview` | box_2d + segmentation mask |

grounding 单独一个槽是有原因的：**3.x Pro 线明确文档化了 `box_2d` + segmentation mask 输出，Flash 线没有。** 而管线 B 的拆解精度几乎全押在这上面。规划和 OCR 这些活儿用 3.7 Flash（$0.75/$3.75，正式版）比 3.1 Pro（$2/$12，还挂 preview）划算得多，但掩码这一步值不值那点钱，切一下对比就知道。两个槽都能在 UI 里按次覆盖。

### 4. 历史记录：localStorage 索引 + IndexedDB 数据

运行记录的**索引**存 localStorage（列表秒开、devtools 里可读），**图层数据**存 IndexedDB。因为图层是 data URI，localStorage 那 ~5MB 配额大概只装得下两张生成图，而这个 demo 的意义就是攒很多次运行来对比。

`/history` 可以勾最多 3 条并排比：缩略图、图层数 / 文字层数、耗时、成本、每一步的明细、所有中间产物。

## 目录结构

```
app/api/plan       提示词 → Scene JSON（管线 A 第一步）
app/api/generate   单次出图（所有渲染都走这里）
app/api/analyze    平图 → 元素 + 文字 + z-order（管线 B 的读版面）
app/api/segment    Gemini 原生 grounding，返回 box_2d + 掩码
app/api/erase      把元素/文字擦掉并重建背景（纯 API 版的 inpaint）

lib/matte.ts       浏览器端 alpha 恢复：双渲染差值 / 色键 / 掩码 / 自动裁边
lib/prompts.ts     所有 prompt 模板与 JSON schema
lib/pipeline/      两条管线的编排（跑在浏览器，逐步上报进度和成本）
lib/export.ts      导出 PNG / SVG(文字为 <text>) / Scene JSON
lib/history.ts     localStorage 索引 + IndexedDB 存储

components/Stage.tsx   DOM 图层编辑器：拖拽、缩放、双击直接改字
app/selftest           抠图算法自检，不消耗 API
```

## 这套方案参考了什么

事后拆解那条线（管线 B）基本是 **ReDesign**（2026）的形状，去掉本地 GPU：VLM 当控制器读版面，原生 grounding 出掩码，图像模型顶替本地 LaMa 做补洞。

值得知道的相关工作：

- [**Qwen-Image-Layered**](https://github.com/QwenLM/Qwen-Image-Layered) — Apache 2.0，ComfyUI 原生支持，端到端拆成多张 RGBA 图层，支持变层数和递归再拆。目前**最强的开源可落地拆解方案**，但要 GPU（1024px 约 120s，峰值 45GB），所以没做进这个纯 API demo。
- [**ReDesign**](https://arxiv.org/html/2607.25565) — agentic 分解树，VLM 控制器在五个 action 间递归选择，每步有 verifier 判 accept / prune / retry。
- [**OmniPSD**](https://arxiv.org/pdf/2512.09247) — 文字层恢复：OCR → 字体嵌入检索 → 矢量重渲染，产出真·可编辑 PSD 文本对象。
- [**LayerD**](https://www.emergentmind.com/topics/layerd) / [**LiWi**](https://arxiv.org/html/2605.14552) / [**LaDe**](https://arxiv.org/pdf/2603.17965) — 自然图像分层的学术 SOTA。

## 已知边界

- **双渲染差值靠模型两次生成的一致性。** 主体漂移会直接变成 alpha 噪点。Nano Banana 的跨次一致性够好，但不是保证。
- **管线 B 的字体是猜的。** 模型从一个候选列表里挑最接近的，不是真的字体识别（那需要 WhatFontIs 一类的服务）。
- **`erase` 是整图重绘**，模型可能顺手改动本该不变的区域。生产环境应该配掩码做局部重绘。
- **z-order 是模型推断的**，没有深度估计兜底（那需要 Depth Anything 一类的本地模型）。
