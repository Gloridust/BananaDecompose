# 架构

## 一句话

**每个 API 路由只做一次模型调用，多步编排全部在浏览器里。**

这条约束决定了其余所有设计：没有任何函数会逼近 Vercel Hobby 的 60s 上限，不需要队列或后端状态，直接 import 仓库就能部署。代价是所有像素运算必须在浏览器 canvas 上跑 —— 反过来这也成了优点，抠图和字形测量的中间结果在 devtools 里直接可查。

## 数据模型

### Scene —— 两条管线的共同产物

```ts
type Scene = {
  canvas: { width, height, background }
  layers: Layer[]        // 索引 0 最先渲染（最底）
}

type Layer = ImageLayer | TextLayer
```

`ImageLayer` 可以带 `retype` —— 表示这层是**保留原始笔画的文字**，不是文本节点。它带着识别出的内容和一张原字裁片，改字时把裁片作为 style reference 交给图像模型重绘。见[文字回收](./text-recovery.md#保留原始笔画)。

### Board —— 一张画布

```ts
type Board = {
  id, createdAt, prompt
  rounds: number              // 这张画布上叠加了几轮
  branches: BoardBranch[]     // 每条方案分支
  nodes: BoardNode[]          // 每个中间产物
  totalMs, serialMs, prepMs, totalCost, concurrency
}
```

一次生成 = 一轮。单次运行是只有一条分支的轮次，一键评测是七条分支的轮次。**同一张画布可以叠加多轮**：跑一遍扫描、改个参数再跑一遍，两组结果并排放在一张画布上。

### BoardNode —— 一个中间产物

```ts
type BoardNode = {
  id, kind, label, detail?
  branches: string[]   // 消费这个节点的分支。长度 > 1 = 共享上游
  inputs: string[]     // 指向来源节点
  status, ms?, cost?, error?
  images?, scene?, metrics?, summary?
}
```

九种 `kind`：`prompt` `plan` `plate` `source` `analysis` `renders` `cuts` `text` `erase` `scene`。

**`branches.length > 1` 是整个设计的关键**。共享上游只画一次，卡片上标「共享 ×N」。关掉一条分支时，只被它用到的节点连边一起消失，共享节点因为还有别的分支在用而留下 —— 这个行为本身就说明了哪些东西是共用的，也就说明了为什么对比是公平的。

### 节点 id 的作用域

共享上游按**轮次**命名而不是按画布：

```ts
sharedNodes('r2') // → { prompt: 'n:r2:prompt', plan: 'n:r2:plan', ... }
```

分支节点是 `n:${branchId}:${kind}`，而 `branchId` 是 `${runKey}:${armId}`。所以：

- 一轮之内，所有 compose 分支的 plan 节点 id 相同 → 自动合并成一个共享节点
- 两轮之间不会合并 → 第二轮有自己的 plan，两轮的同名分支也是两条独立分支

## 布局引擎

`lib/board.ts` 是一个分层 DAG 布局：

1. **深度** = 从根节点算的最长路径 → 决定列
2. **泳道** = 分支序号；喂多条分支的共享节点取这些分支序号的均值 → 居中在它服务的那几条之间
3. 同一列内按泳道排序，再逐个下推避开重叠

边是从上游卡片右缘到下游卡片左缘的三次贝塞尔。

`/selftest` 用一张合成的三分支画布验证这套布局，不消耗 API。

## 并发

### 两阶段

```
阶段 0（共享上游，两条管线互不依赖，并行）
  规划 ──→ 背景板     ┐
  来源图              ┘

阶段 1（全部分支同时开跑）
```

早期版本把共享上游藏在第一条分支里，后面每条分支都得等它整条跑完 —— 七条分支实际串行。提取成独立阶段后才可能真正并行。

### 全局调度器

`lib/pipeline/scheduler.ts` 是一个信号量，**所有分支共用一个在飞请求池**：

```ts
schedule(async () => { /* 一次模型调用 */ })
```

节流从「每条分支各限 N 路」改成全局限流，于是分支数量不再乘进请求量 —— 加分支只会排队，不会打爆限流。上限在左栏可调（默认 4）。运行时顶栏实时显示 `在飞 3/4 · 排队 7`。

### 耗时统计

- **成品场景节点**上标 `⏱ 48.3s` —— 这条路径的墙钟耗时
- 顶栏 `墙钟 118s / 串行 312s · 省 62%` —— 并发省了多少，量出来而不是估

## 存储

| 存哪 | 存什么 | 为什么 |
|---|---|---|
| localStorage | 画布索引（`bd:boards:index:v2`）、设置（`bd:settings`） | 列表秒开，devtools 里可读 |
| IndexedDB | 完整画布（节点、图像 data URI） | 节点图像是 data URI，localStorage 那 ~5MB 大概只装得下两张生成图 |

索引 key 带版本号，旧数据模型的记录会被留在原地而不是让列表崩掉。

设置的合并**下沉一层**：顶层浅合并会让存过的 `decompose` 块整块替换掉默认块，后加的选项全变成 `undefined` —— 静默关闭，而 UI 还把这个过时形状显示得像是主动选的。
