# API

六个路由，**每个只做一次模型调用**。多步编排在浏览器里，所以没有任何函数会逼近 Vercel Hobby 的 60s 上限。

全部走 [OpenRouter](https://openrouter.ai)，服务端读 `OPENROUTER_API_KEY`，**key 从不下发到浏览器**。

## 模型槽

| 环境变量 | 默认 | 用途 |
|---|---|---|
| `OPENROUTER_IMAGE_MODEL` | `google/gemini-3.1-flash-image` | 出图、编辑、擦除重绘 |
| `OPENROUTER_VISION_MODEL` | `google/gemini-3.7-flash` | 规划、读版面、OCR、裁图复核 |
| `OPENROUTER_GROUNDING_MODEL` | `google/gemini-3.1-pro-preview` | `box_2d` + segmentation mask |

grounding 单独一个槽是有原因的：**3.x Pro 线明确文档化了 segmentation mask 输出，Flash 线没有**，而拆解精度押在这上面。规划和 OCR 用 3.7 Flash（$0.75/$3.75，正式版）比 3.1 Pro（$2/$12，仍是 preview）划算得多。两个槽都能在 UI 里按次覆盖。

## 路由

### `POST /api/plan`
提示词 → `ScenePlan`（背景、元素、文案）。用 `response_format` 的 JSON schema 约束。

### `POST /api/generate`
一次出图。透传 `aspect_ratio` / `resolution` / `seed` / `input_references`。返回 data URI。

编辑和擦除也走这里，靠 `references` 传参考图。

### `POST /api/analyze`
平图 → 元素列表（label + box + z）+ 文案列表（内容 + box + 颜色 + 字体 + 字重 + 字号 + 对齐 + 斜体）。

### `POST /api/segment`
**一次一个对象。** 返回 `box_2d` + base64 PNG 掩码。

> 批量请求所有掩码实测 **>170s 才超时** —— 掩码是以 base64 文本形式混在补全流里返回的，多个对象叠起来就是几万 token 的纯文本输出。现在每次只问一个，输入图降到 768px，45s 超时后**干净降级**（返回 `degraded: true`）而不是 504。

### `POST /api/refine-text`
放大的文字裁片 → 精确内容、字体、字重、斜体。**不问几何** —— 那是本地量出来的。

### `POST /api/erase`
图 + 要移除的目标 → 重建后的图。

> 提示词刻意写成「把表面恢复成空白状态」这类**修复式**表述，而不是枚举"移除文字/字母/数字"。后者对着含艺术字的图会触发 Gemini 的版权过滤器，返回 `flagged for copyrighted or trademarked material`。即便如此仍会被拒 —— 被拒时该步骤降级为沿用原图，节点标黄注明，而不是让整条分支归零。

### `GET /api/models`
返回三个槽当前的取值和 key 是否配置。**不返回 key 本身。**

## 超时与降级

| 场景 | 行为 |
|---|---|
| 任意调用超时 | 服务端 55s 上限，返回 504 而不是让平台超时 |
| segment 超时/无掩码 | `degraded: true`，调用方退回矩形裁切，步骤日志注明原因 |
| erase 被拒 | 降级为沿用原图，节点标黄，分支继续 |
| 单个元素失败 | 该元素无图层，其余照常 |
| 单条分支失败 | 只影响这条分支，不弹全局错误 |
