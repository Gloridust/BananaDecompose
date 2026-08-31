'use client'

import { useCallback, useEffect, useState } from 'react'
import { extractInk, fitText, scoreFonts, scoreMargin, FONT_CANDIDATES } from '@/lib/glyph'
import { fontStack } from '@/lib/export'

// Ground truth we control exactly: render type at a known size, colour and
// position over a textured ground, then ask the engine to recover it from pixels
// alone. Whatever it gets wrong here it will also get wrong on a real poster.

const W = 900
const H = 260

type Case = {
  name: string
  truth: { text: string; family: string; weight: number; size: number; color: string; x: number; y: number }
  measured: { size: number; color: string; dx: number; dy: number; dw: number; dh: number } | null
  fontPick: { family: string; score: number; widthFit: number; edgeIou: number; decisive: boolean } | null
  source: string
  overlay: string
}

function ctxOf(w: number, h: number) {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return { canvas: c, ctx: c.getContext('2d', { willReadFrequently: true })! }
}

/** A textured ground, so the split cannot succeed by assuming a flat backdrop. */
function paintGround(ctx: CanvasRenderingContext2D) {
  const g = ctx.createLinearGradient(0, 0, W, H)
  g.addColorStop(0, '#e8dcc4')
  g.addColorStop(1, '#cbb894')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, W, H)
  ctx.globalAlpha = 0.16
  for (let i = 0; i < 260; i++) {
    const x = ((i * 7919) % W) + ((i * 104729) % 13) * 0.5
    const y = ((i * 6271) % H) + ((i * 15485863) % 11) * 0.5
    ctx.fillStyle = i % 3 === 0 ? '#8a7247' : '#fffaf0'
    ctx.fillRect(x, y, 3, 3)
  }
  ctx.globalAlpha = 1
}

function render(truth: Case['truth']) {
  const { canvas, ctx } = ctxOf(W, H)
  paintGround(ctx)
  ctx.fillStyle = truth.color
  ctx.textBaseline = 'top'
  ctx.textAlign = 'left'
  ctx.font = `${truth.weight} ${truth.size}px ${fontStack(truth.family)}`
  ctx.fillText(truth.text, truth.x, truth.y)

  // The ink box the engine should recover, measured the same way it will be.
  const m = ctx.measureText(truth.text)
  const inkBox = {
    x: truth.x - m.actualBoundingBoxLeft,
    y: truth.y - m.actualBoundingBoxAscent,
    w: m.actualBoundingBoxLeft + m.actualBoundingBoxRight,
    h: m.actualBoundingBoxAscent + m.actualBoundingBoxDescent,
  }
  return { src: canvas.toDataURL('image/png'), inkBox }
}

/** Draw the recovered layer over the source in a contrasting colour. Perfect
 *  recovery makes the two coincide; drift shows up immediately as doubling. */
function overlay(src: string, truth: Case['truth'], fit: ReturnType<typeof fitText>, family: string, weight: number) {
  return new Promise<string>((resolve) => {
    const img = new Image()
    img.onload = () => {
      const { canvas, ctx } = ctxOf(W, H)
      ctx.drawImage(img, 0, 0)
      ctx.globalAlpha = 0.55
      ctx.fillStyle = '#ff2d55'
      ctx.textBaseline = 'top'
      ctx.textAlign = 'left'
      ctx.font = `${weight} ${fit.fontSize}px ${fontStack(family)}`
      ;(ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${fit.letterSpacing}px`
      ctx.fillText(truth.text, fit.x, fit.y)
      resolve(canvas.toDataURL('image/png'))
    }
    img.src = src
  })
}

const TRUTHS: Case['truth'][] = [
  { text: '晨间萃取', family: 'Noto Serif SC', weight: 700, size: 96, color: '#3a2416', x: 90, y: 60 },
  { text: '周六 9:00 · 三号仓库', family: 'Noto Sans SC', weight: 500, size: 46, color: '#5a4023', x: 70, y: 100 },
  { text: 'MORNING EXTRACTION', family: 'Bebas Neue', weight: 400, size: 78, color: '#241a10', x: 60, y: 80 },
]

export default function GlyphTest() {
  const [cases, setCases] = useState<Case[]>([])
  const [busy, setBusy] = useState(false)

  const run = useCallback(async () => {
    setBusy(true)
    // Web fonts must be resolved before anything is measured or rendered.
    await document.fonts.ready
    const out: Case[] = []

    for (const truth of TRUTHS) {
      const { src, inkBox } = render(truth)
      // Feed a deliberately sloppy box — this is what a vision model actually gives.
      const sloppy: [number, number, number, number] = [
        ((inkBox.y - 14) / H) * 1000,
        ((inkBox.x - 20) / W) * 1000,
        ((inkBox.y + inkBox.h + 18) / H) * 1000,
        ((inkBox.x + inkBox.w + 26) / W) * 1000,
      ]

      const ink = await extractInk(src, sloppy)
      if (!ink) {
        out.push({ name: truth.text, truth, measured: null, fontPick: null, source: src, overlay: src })
        continue
      }

      const ranked = await scoreFonts(truth.text, FONT_CANDIDATES, ink, false)
      const best = ranked[0]
      const fit = fitText(truth.text, truth.family, truth.weight, false, ink.box)

      out.push({
        name: truth.text,
        truth,
        measured: {
          size: fit.fontSize,
          color: ink.color,
          dx: ink.box.x - inkBox.x,
          dy: ink.box.y - inkBox.y,
          dw: ink.box.w - inkBox.w,
          dh: ink.box.h - inkBox.h,
        },
        fontPick: best
          ? { family: best.family, score: best.score, widthFit: best.widthFit, edgeIou: best.edgeIou, decisive: scoreMargin(ranked) >= 0.06 }
          : null,
        source: src,
        overlay: await overlay(src, truth, fit, truth.family, truth.weight),
      })
    }

    setCases(out)
    setBusy(false)
  }, [])

  useEffect(() => {
    run()
  }, [run])

  return (
    <section className="mb-6">
      <div className="mb-2 flex items-center gap-3">
        <h2 className="text-sm text-ink-50">字形贴合自检</h2>
        <button
          onClick={run}
          disabled={busy}
          className="rounded border border-ink-700 px-2 py-0.5 font-mono text-[10px] text-ink-400 hover:text-banana-400 disabled:opacity-50"
        >
          {busy ? '运行中…' : '重跑'}
        </button>
      </div>
      <p className="mb-3 max-w-3xl text-[11px] leading-relaxed text-ink-400">
        用已知字号/位置/颜色的文字渲染到<strong className="text-ink-200">带纹理的底</strong>上，再喂给引擎一个
        <strong className="text-ink-200">故意画歪的粗框</strong>（模拟 VLM 给的 box_2d），看它能不能从像素里把真值量回来。
        红色是恢复出来的层叠在原图上 —— 完全重合就说明对齐了，双影就是没对上。
      </p>

      <div className="space-y-3">
        {cases.map((c) => {
          const ok = c.measured && Math.abs(c.measured.dx) <= 2 && Math.abs(c.measured.dy) <= 2
          return (
            <article key={c.name} className="rounded-lg border border-ink-800 bg-ink-900 p-3">
              <div className="mb-2 flex flex-wrap items-baseline gap-x-4 gap-y-1 font-mono text-[10px]">
                <span className="text-ink-50">{c.name}</span>
                <span
                  className={`rounded px-1.5 py-0.5 text-[9px] ${
                    ok ? 'bg-emerald-500/20 text-emerald-300' : 'bg-amber-500/20 text-amber-300'
                  }`}
                >
                  {ok ? 'ALIGNED' : c.measured ? 'DRIFT' : 'NO INK'}
                </span>
                {c.measured ? (
                  <>
                    <Stat k="字号真值" v={`${c.truth.size}px`} />
                    <Stat k="量出" v={`${c.measured.size.toFixed(1)}px`} />
                    <Stat k="位置偏差" v={`${c.measured.dx.toFixed(1)}, ${c.measured.dy.toFixed(1)}px`} />
                    <Stat k="尺寸偏差" v={`${c.measured.dw.toFixed(1)}, ${c.measured.dh.toFixed(1)}px`} />
                    <Stat k="颜色真值" v={c.truth.color} />
                    <Stat k="量出" v={c.measured.color} />
                    {c.fontPick ? (
                      <Stat
                        k="字体回测"
                        v={`${c.fontPick.family}${c.fontPick.family === c.truth.family ? ' ✓' : ` ✗ 真值 ${c.truth.family}`} · 宽度 ${(
                          c.fontPick.widthFit * 100
                        ).toFixed(0)}% 轮廓 ${(c.fontPick.edgeIou * 100).toFixed(0)}%${c.fontPick.decisive ? '' : ' · 不够分辨，交回模型'}`}
                      />
                    ) : null}
                  </>
                ) : null}
              </div>
              <div className="overflow-hidden rounded border border-ink-800">
                <img src={c.overlay} alt="" className="w-full" />
              </div>
            </article>
          )
        })}
      </div>
    </section>
  )
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <span className="tabular-nums">
      <span className="text-ink-600">{k} </span>
      <span className="text-ink-200">{v}</span>
    </span>
  )
}
