'use client'

import { MATTE_STRATEGIES, TEXT_STRATEGIES } from '@/lib/types'
import type { ComposeOptions, DecomposeOptions, PipelineId } from '@/lib/types'

export const ASPECTS = ['1:1', '4:5', '3:2', '16:9', '9:16']
export const RESOLUTIONS = ['1K', '2K', '4K']

export type Settings = {
  pipeline: PipelineId
  prompt: string
  /** Global cap on in-flight model calls, across every branch at once. */
  concurrency: number
  compose: ComposeOptions
  decompose: DecomposeOptions
}

export const DEFAULT_SETTINGS: Settings = {
  pipeline: 'compose',
  concurrency: 4,
  prompt: '一张咖啡品鉴会的海报：暖褐色纸质背景，一只手冲壶、一个陶瓷杯、几颗散落的咖啡豆，标题「晨间萃取」，副标题「周六 9:00 · 三号仓库」',
  compose: { matte: 'dual', text: 'live', aspectRatio: '4:5', resolution: '1K', maxElements: 4, visionModel: '' },
  decompose: { aspectRatio: '4:5', resolution: '1K', useMasks: true, inpaintBackground: true, maxElements: 6, groundingModel: '', visionModel: '' },
}

const PIPELINES: { id: PipelineId; label: string; blurb: string }[] = [
  { id: 'compose', label: 'A · 生成即分层', blurb: '先规划结构，元素逐个独立渲染，文字全程不入像素。可编辑性是设计出来的。' },
  { id: 'decompose', label: 'B · 事后拆解', blurb: '先出一张拍平的成品，再用 VLM 读版面 + 分割掩码 + 重绘补洞把它拆回图层。可编辑性是抢救出来的。' },
]

export default function Controls({
  settings,
  onChange,
  running,
  onRun,
  onCancel,
  onUpload,
  sourceImage,
  onClearSource,
  models,
}: {
  settings: Settings
  onChange: (patch: Partial<Settings>) => void
  running: boolean
  onRun: () => void
  onCancel: () => void
  onUpload: (file: File) => void
  sourceImage: string | null
  onClearSource: () => void
  models: { image: string; vision: string; grounding: string } | null
}) {
  const isCompose = settings.pipeline === 'compose'
  const active = PIPELINES.find((p) => p.id === settings.pipeline)!

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-1.5">
        {PIPELINES.map((p) => (
          <button
            key={p.id}
            disabled={running}
            onClick={() => onChange({ pipeline: p.id })}
            className={`rounded border px-2 py-2 text-left text-xs transition disabled:opacity-50 ${
              settings.pipeline === p.id
                ? 'border-banana-500 bg-banana-500/10 text-banana-400'
                : 'border-ink-700 text-ink-200 hover:border-ink-600'
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>
      <p className="text-[11px] leading-relaxed text-ink-400">{active.blurb}</p>

      <textarea
        value={settings.prompt}
        onChange={(e) => onChange({ prompt: e.target.value })}
        rows={4}
        placeholder="描述你想要的画面…"
        className="w-full resize-y rounded border border-ink-700 bg-ink-900 px-2.5 py-2 text-xs leading-relaxed outline-none focus:border-banana-500"
      />

      {isCompose ? (
        <ComposeControls opts={settings.compose} onChange={(p) => onChange({ compose: { ...settings.compose, ...p } })} />
      ) : (
        <DecomposeControls
          opts={settings.decompose}
          onChange={(p) => onChange({ decompose: { ...settings.decompose, ...p } })}
          onUpload={onUpload}
          sourceImage={sourceImage}
          onClearSource={onClearSource}
        />
      )}

      <div className="flex gap-2">
        <button
          onClick={running ? onCancel : onRun}
          className={`flex-1 rounded px-3 py-2 text-xs font-medium transition ${
            running ? 'bg-rose-500/90 text-white hover:bg-rose-500' : 'bg-banana-500 text-ink-950 hover:bg-banana-400'
          }`}
        >
          {running ? '取消运行' : sourceImage && !isCompose ? '拆解这张图' : '运行'}
        </button>
      </div>

      <label className="block">
        <span className="mb-1 flex items-baseline justify-between font-mono text-[9px] uppercase tracking-wide text-ink-400">
          <span>并发上限</span>
          <span className="tabular-nums text-ink-200">{settings.concurrency}</span>
        </span>
        <input
          type="range"
          min={1}
          max={10}
          value={settings.concurrency}
          onChange={(e) => onChange({ concurrency: Number(e.target.value) })}
          className="w-full accent-banana-500"
        />
        <span className="mt-1 block text-[10px] leading-snug text-ink-400">
          全局同时在飞的模型调用数，所有分支共用这一个池子。调高更快，但更容易撞上限流 —— 撞了就调回来。
        </span>
      </label>

      {models ? (
        <p className="font-mono text-[9px] leading-relaxed text-ink-600">
          image: {models.image}
          <br />
          vision: {settings.compose.visionModel || settings.decompose.visionModel || models.vision}
          <br />
          grounding: {settings.decompose.groundingModel || models.grounding}
        </p>
      ) : null}
    </div>
  )
}

function ComposeControls({ opts, onChange }: { opts: ComposeOptions; onChange: (p: Partial<ComposeOptions>) => void }) {
  return (
    <div className="space-y-3">
      <Field label="抠图策略（Nano Banana 不输出 alpha，必须挑一种）">
        <div className="space-y-1">
          {MATTE_STRATEGIES.map((s) => (
            <button
              key={s.id}
              onClick={() => onChange({ matte: s.id })}
              className={`block w-full rounded border px-2 py-1.5 text-left transition ${
                opts.matte === s.id ? 'border-banana-500 bg-banana-500/10' : 'border-ink-800 hover:border-ink-600'
              }`}
            >
              <span className={`text-xs ${opts.matte === s.id ? 'text-banana-400' : 'text-ink-200'}`}>{s.label}</span>
              <span className="mt-0.5 block text-[10px] leading-snug text-ink-400">{s.note}</span>
            </button>
          ))}
        </div>
      </Field>

      <Field label="文字策略">
        <div className="space-y-1">
          {TEXT_STRATEGIES.map((s) => (
            <button
              key={s.id}
              onClick={() => onChange({ text: s.id })}
              className={`block w-full rounded border px-2 py-1.5 text-left transition ${
                opts.text === s.id ? 'border-banana-500 bg-banana-500/10' : 'border-ink-800 hover:border-ink-600'
              }`}
            >
              <span className={`text-xs ${opts.text === s.id ? 'text-banana-400' : 'text-ink-200'}`}>{s.label}</span>
              <span className="mt-0.5 block text-[10px] leading-snug text-ink-400">{s.note}</span>
            </button>
          ))}
        </div>
      </Field>

      <SharedControls
        aspectRatio={opts.aspectRatio}
        resolution={opts.resolution}
        maxElements={opts.maxElements}
        maxElementsLabel="元素上限"
        onChange={onChange as (p: Record<string, unknown>) => void}
      />

      <Field label="规划模型（留空用服务端默认）">
        <input
          value={opts.visionModel ?? ''}
          onChange={(e) => onChange({ visionModel: e.target.value })}
          placeholder="google/gemini-3.7-flash"
          className="w-full rounded border border-ink-700 bg-ink-900 px-2 py-1.5 font-mono text-[10px] outline-none focus:border-banana-500"
        />
      </Field>
    </div>
  )
}

function DecomposeControls({
  opts,
  onChange,
  onUpload,
  sourceImage,
  onClearSource,
}: {
  opts: DecomposeOptions
  onChange: (p: Partial<DecomposeOptions>) => void
  onUpload: (file: File) => void
  sourceImage: string | null
  onClearSource: () => void
}) {
  return (
    <div className="space-y-3">
      <Field label="来源图">
        {sourceImage ? (
          <div className="flex items-center gap-2">
            <img src={sourceImage} alt="来源" className="h-12 w-12 rounded border border-ink-700 object-cover" />
            <button onClick={onClearSource} className="rounded border border-ink-700 px-2 py-1 text-[10px] text-ink-400 hover:text-ink-50">
              改回用提示词生成
            </button>
          </div>
        ) : (
          <label className="block cursor-pointer rounded border border-dashed border-ink-700 px-2 py-3 text-center text-[11px] text-ink-400 hover:border-banana-500 hover:text-ink-200">
            上传一张平图来拆，或留空 → 先用上面的提示词生成一张
            <input
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) onUpload(f)
                e.target.value = ''
              }}
            />
          </label>
        )}
      </Field>

      <Toggle
        checked={opts.useMasks}
        onChange={(v) => onChange({ useMasks: v })}
        label="请求分割掩码"
        note="关掉就只按 bbox 矩形裁切 —— 这是拆解精度差距最大的一个开关。"
      />
      <Toggle
        checked={opts.inpaintBackground}
        onChange={(v) => onChange({ inpaintBackground: v })}
        label="重绘补全背景"
        note="把元素抬走后留下的洞交给 Nano Banana 补。关掉则背景层保留原图，元素会重影。"
      />

      <SharedControls
        aspectRatio={opts.aspectRatio}
        resolution={opts.resolution}
        maxElements={opts.maxElements}
        maxElementsLabel="拆出元素上限"
        onChange={onChange as (p: Record<string, unknown>) => void}
      />

      <Field label="读版面模型 / grounding 模型">
        <div className="space-y-1">
          <input
            value={opts.visionModel ?? ''}
            onChange={(e) => onChange({ visionModel: e.target.value })}
            placeholder="google/gemini-3.7-flash"
            className="w-full rounded border border-ink-700 bg-ink-900 px-2 py-1.5 font-mono text-[10px] outline-none focus:border-banana-500"
          />
          <input
            value={opts.groundingModel ?? ''}
            onChange={(e) => onChange({ groundingModel: e.target.value })}
            placeholder="google/gemini-3.1-pro-preview"
            className="w-full rounded border border-ink-700 bg-ink-900 px-2 py-1.5 font-mono text-[10px] outline-none focus:border-banana-500"
          />
        </div>
        <p className="mt-1 text-[10px] leading-snug text-ink-400">
          掩码单独一个槽：3.x Pro 明确支持 box_2d + segmentation mask，Flash 线的文档没写。切回 Pro 对比一下就知道值不值那点钱。
        </p>
      </Field>
    </div>
  )
}

function SharedControls({
  aspectRatio,
  resolution,
  maxElements,
  maxElementsLabel,
  onChange,
}: {
  aspectRatio: string
  resolution: string
  maxElements: number
  maxElementsLabel: string
  onChange: (p: Record<string, unknown>) => void
}) {
  return (
    <div className="grid grid-cols-2 gap-2">
      <Field label="比例">
        <select
          value={aspectRatio}
          onChange={(e) => onChange({ aspectRatio: e.target.value })}
          className="w-full rounded border border-ink-700 bg-ink-900 px-2 py-1.5 text-xs outline-none focus:border-banana-500"
        >
          {ASPECTS.map((a) => (
            <option key={a}>{a}</option>
          ))}
        </select>
      </Field>
      <Field label="分辨率">
        <select
          value={resolution}
          onChange={(e) => onChange({ resolution: e.target.value })}
          className="w-full rounded border border-ink-700 bg-ink-900 px-2 py-1.5 text-xs outline-none focus:border-banana-500"
        >
          {RESOLUTIONS.map((r) => (
            <option key={r}>{r}</option>
          ))}
        </select>
      </Field>
      <div className="col-span-2">
        <Field label={`${maxElementsLabel}：${maxElements}`}>
          <input
            type="range"
            min={1}
            max={10}
            value={maxElements}
            onChange={(e) => onChange({ maxElements: Number(e.target.value) })}
            className="w-full accent-banana-500"
          />
        </Field>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block font-mono text-[9px] uppercase tracking-wide text-ink-400">{label}</span>
      {children}
    </label>
  )
}

function Toggle({ checked, onChange, label, note }: { checked: boolean; onChange: (v: boolean) => void; label: string; note: string }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      className={`block w-full rounded border px-2 py-1.5 text-left transition ${
        checked ? 'border-banana-500/60 bg-banana-500/10' : 'border-ink-800 hover:border-ink-600'
      }`}
    >
      <span className="flex items-center gap-2">
        <span className={`font-mono text-[11px] ${checked ? 'text-banana-400' : 'text-ink-600'}`}>{checked ? '[x]' : '[ ]'}</span>
        <span className={`text-xs ${checked ? 'text-banana-400' : 'text-ink-200'}`}>{label}</span>
      </span>
      <span className="mt-0.5 block pl-6 text-[10px] leading-snug text-ink-400">{note}</span>
    </button>
  )
}
