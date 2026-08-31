# BananaDecompose

用 **Nano Banana 2**（`google/gemini-3.1-flash-image`，走 OpenRouter）生成图像，并把它变成**可编辑的图层 + 可改的文字**。

中间是一张**节点画布**：每条方案分支的每个中间产物 —— 规划、背景板、每张原始底片、每次抠图、擦除重建、最终成品 —— 都是画布上的一个节点，边指向它的来源。共享的上游只画一次，所以「为什么这个对比是公平的」是画出来的，不是写在文档里的。

一次生成 = 一轮 = 若干分支。一张画布可以叠加多轮，也就是一条历史记录。

## 两条管线，可切换、可并排对比

| | A · 生成即分层 | B · 事后拆解 |
|---|---|---|
| 思路 | 先规划结构，元素逐个独立渲染，文字全程不进像素 | 先出一张拍平的成品，再拆回图层 |
| 可编辑性 | **设计出来的** —— 文字是真文本节点，图层天生独立 | **抢救出来的** —— 文字靠测量回收，图层靠分割 + 重绘补洞 |
| 精度上限 | 无损（元素本来就没合过） | 约 PSNR 26 / LPIPS 0.09，视觉可用但非像素级 |
| 画面丰富度 | 受限 —— 每个元素必须能孤立渲染，排除了遮挡和交互 | 好 —— 图像模型一次画完 |
| 能处理外来图 | ❌ | ✅ |

## 快速开始

```bash
npm install
cp .env.local.example .env.local   # 填入 OPENROUTER_API_KEY
npm run dev
```

打开 <http://localhost:3000>。

不填 key 也能打开 **<http://localhost:3000/selftest>** —— 抠图数学、字形拟合、画布布局三项自检，全部用已知真值验证，不消耗任何 API。**跑真实管线之前建议先看这里。**

## 部署到 Vercel

直接 import 仓库。唯一必须配的环境变量是 `OPENROUTER_API_KEY`。

架构上为 serverless 做了让步：**每个 API route 只做一次模型调用**，多步编排全部在浏览器里。所以没有任何函数会逼近 Vercel Hobby 的 60s 上限，也不需要队列或后端状态。

## 三条绕不开的约束

这个项目大半的复杂度来自三件事：

**1. Gemini 系图像模型全都不输出 alpha 通道。**
要求"透明背景"拿到的是纯白、纯黑或画上去的马赛克格子。所以透明必须算出来 —— 双渲染差值（白底+黑底解方程）实测平均 alpha 误差 **0.10%**，色键抠图 **4.17%**。→ [抠图](./doc/matting.md)

**2. Gemini 的 `box_2d` 精度不足以定位文字，`fontSize` 是猜的。**
所以职责拆开：**模型说这是什么字、像什么字体；像素说它在哪、多大、什么颜色。** 自检实测位置偏差 <1px、颜色完全一致、字体 3/3 正确。→ [文字回收](./doc/text-recovery.md)

**3. 底板上还留着被抬走的东西，就不是分层文件。**
所以背景重建是强制的，而且只在真正抬走东西的地方合成重绘像素、其余像素与原图逐位一致。→ [设计决策](./doc/decisions.md#背景重建没有开关)

## 文档

| | |
|---|---|
| [架构](./doc/architecture.md) | 数据模型、节点画布、并发调度、存储 |
| [两条管线](./doc/pipelines.md) | 逐步拆解，以及共享上游为什么这么设计 |
| [抠图](./doc/matting.md) | 三种 alpha 恢复策略与实测数据 |
| [文字回收](./doc/text-recovery.md) | 字形测量、字号字距拟合、字体判定、原始笔画保留 |
| [API](./doc/api.md) | 六个路由的输入输出与超时降级 |
| [界面](./doc/ui.md) | 画布手势、分支开关、编辑器、评测与历史 |
| [设计决策](./doc/decisions.md) | 每个取舍的理由，以及**被推翻过的做法** |

## 目录结构

```
app/api/plan         提示词 → Scene JSON
app/api/generate     单次出图（所有渲染都走这里）
app/api/analyze      平图 → 元素 + 文字 + z-order
app/api/segment      Gemini 原生 grounding，一次一个对象
app/api/refine-text  放大的文字裁片 → 精确内容与字体
app/api/erase        擦除并重建背景

lib/matte.ts             浏览器端 alpha 恢复、按区域合成、裁图放大
lib/glyph.ts             字形测量与拟合：Otsu 分离墨迹、字号字距解算、字体回测
lib/retype.ts            保留原始笔画的图层改字：按原样式重绘
lib/metrics.ts           从产出像素里算指标：软边、存活面积、底色残留、重建 PSNR/L1
lib/board.ts             分层 DAG 布局：深度分列、分支分道、共享节点居中
lib/benchmark.ts         一键评测的方案矩阵与成本估算
lib/pipeline/            两条管线 + 全局请求调度器 + 文字回收编排

components/Board.tsx        节点画布：平移缩放、贝塞尔连线、节点/分支开关
components/SceneEditor.tsx  图层编辑器浮层（点成品场景节点打开）
app/selftest                三项自检，不消耗 API
```

## 这套方案参考了什么

事后拆解那条线基本是 **ReDesign**（2026）的形状，去掉本地 GPU。值得知道的相关工作：

- [**Qwen-Image-Layered**](https://github.com/QwenLM/Qwen-Image-Layered) — Apache 2.0，ComfyUI 原生，端到端拆成多张 RGBA 图层，支持变层数和递归再拆。目前**最强的开源可落地拆解方案**，但要 GPU（1024px 约 120s，峰值 45GB）
- [**ReDesign**](https://arxiv.org/html/2607.25565) — agentic 分解树，VLM 控制器在五个 action 间递归选择，每步有 verifier 判 accept / prune / retry
- [**OmniPSD**](https://arxiv.org/pdf/2512.09247) — 文字层恢复：OCR → 字体嵌入检索 → 矢量重渲染
- [**LayerD**](https://www.emergentmind.com/topics/layerd) / [**LiWi**](https://arxiv.org/html/2605.14552) / [**LaDe**](https://arxiv.org/pdf/2603.17965) — 自然图像分层的学术 SOTA

一个值得注意的外部信号：Adobe 的 Illustrator/Photoshop [Retype](https://bringyourownlaptop.com/blog/how-to-use-retype-in-illustrator) 曾经能把图里的静态文字转成可编辑文本层，**现在只保留字体识别，转换功能已移除**。

## 已知边界

- **双渲染差值靠模型两次生成的一致性。** 主体漂移会直接变成 alpha 噪点
- **`erase` 是整图重绘 + 按区域合成**，不是真正的局部重绘。而且会被版权过滤器拦（已降级处理，不会炸掉分支）
- **字体回测是弱识别器**，分差不足时会认怂交回模型判断。想更准要么接专用服务，要么用「保留原始笔画」—— 那样根本不需要认字体
- **z-order 是模型推断的**，没有深度估计兜底
- **A 管线的构图偏简单** —— 每个元素必须能孤立渲染，这排除了元素间的遮挡与交互。是路线的固有代价，不是实现问题
