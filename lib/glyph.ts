'use client'

import { loadImage } from './matte'
import { fontStack } from './export'

// Recovering type from a raster has two halves with very different answers.
//
// WHAT it says and WHAT FACE it is — a vision model is good at that, especially
// on a zoomed crop. WHERE it sits and HOW BIG it is — a model can only regress a
// box, while the ink itself can be measured exactly. So geometry comes from
// pixels here, never from box_2d, and the model's fontSize guess is discarded.

export type InkMetrics = {
  /** Tight ink bounds in original-image pixels. */
  box: { x: number; y: number; w: number; h: number }
  /** Median colour of the stroke pixels — the real text colour, not an estimate. */
  color: string
  /** Binary ink mask of the padded crop, kept for font scoring. */
  mask: ImageData
  /** Where the mask sits in the original image. */
  maskOrigin: { x: number; y: number }
  /** Share of the crop that is ink. Very low or very high means the split failed. */
  density: number
  /** The glyphs alone, RGBA, tight to `box`. Soft alpha from the distance field,
   *  so antialiased edges survive instead of being thresholded into jaggies. */
  cut: string
  /** The padded crop, opaque — a style reference for regenerating this run. */
  styleRef: string
}

function ctxOf(w: number, h: number) {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(w))
  canvas.height = Math.max(1, Math.round(h))
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('Canvas 2D context unavailable')
  return { canvas, ctx }
}

/** Otsu's method over a 0..255 histogram — splits ink from ground with no tuning. */
function otsu(hist: number[], total: number) {
  let sum = 0
  for (let i = 0; i < 256; i++) sum += i * hist[i]

  let sumB = 0
  let wB = 0
  let best = 0
  let threshold = 0

  for (let t = 0; t < 256; t++) {
    wB += hist[t]
    if (!wB) continue
    const wF = total - wB
    if (!wF) break
    sumB += t * hist[t]
    const mB = sumB / wB
    const mF = (sum - sumB) / wF
    const between = wB * wF * (mB - mF) * (mB - mF)
    if (between > best) {
      best = between
      threshold = t
    }
  }
  return threshold
}

/**
 * Force the web fonts to be present before anything is measured.
 *
 * `document.fonts.ready` only settles requests already in flight, and a Google
 * Fonts face is not fetched until something actually renders a glyph it covers.
 * Measuring before that silently returns the fallback's metrics — which makes
 * every candidate look identical and every fitted size wrong, with no error.
 */
const fontsLoaded = new Set<string>()

export async function ensureFonts(
  families: { family: string; weight: number }[],
  sample: string,
): Promise<void> {
  if (typeof document === 'undefined' || !document.fonts) return

  const pending: Promise<unknown>[] = []
  for (const f of families) {
    const key = `${f.weight} ${f.family}`
    if (fontsLoaded.has(key)) continue
    fontsLoaded.add(key)
    // The sample text matters: a CJK face ships as many subsets, and only the
    // ones covering these characters get fetched.
    pending.push(document.fonts.load(`${f.weight} 100px "${f.family}"`, sample).catch(() => undefined))
  }

  if (pending.length) await Promise.all(pending)

  // Unreachable web fonts must degrade, never throw: document.fonts.ready
  // rejects when a face fails to load, and letting that propagate would take
  // down the whole text pipeline for anyone behind a restricted network. The
  // fallback metrics are wrong, but wrong beats nothing on screen.
  await document.fonts.ready.catch(() => undefined)
}

/** True when a face actually resolved. Callers can warn instead of silently
 *  measuring the fallback and reporting it as a confident answer. */
export function fontAvailable(family: string, weight = 400) {
  if (typeof document === 'undefined' || !document.fonts) return false
  try {
    return document.fonts.check(`${weight} 100px "${family}"`)
  } catch {
    return false
  }
}

function median(values: number[]) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

function hex(r: number, g: number, b: number) {
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`
}

/**
 * Measure the actual glyph pixels inside a coarse box.
 *
 * The model's box only has to be roughly right: it gets padded, the local
 * background is taken from the crop's border ring, and every pixel is scored by
 * how far it sits from that background. Otsu then splits the resulting distance
 * field, which handles light-on-dark and dark-on-light identically and needs no
 * threshold to be chosen by hand.
 */
export async function extractInk(
  src: string,
  box: [number, number, number, number],
  opts: { pad?: number } = {},
): Promise<InkMetrics | null> {
  const pad = opts.pad ?? 0.2
  const img = await loadImage(src)
  const W = img.naturalWidth
  const H = img.naturalHeight

  const [y0, x0, y1, x1] = box
  const bw = ((x1 - x0) / 1000) * W
  const bh = ((y1 - y0) / 1000) * H
  const px = Math.max(4, bw * pad)
  const py = Math.max(4, bh * pad)

  const sx = Math.max(0, Math.round((x0 / 1000) * W - px))
  const sy = Math.max(0, Math.round((y0 / 1000) * H - py))
  const sw = Math.min(W - sx, Math.round(bw + px * 2))
  const sh = Math.min(H - sy, Math.round(bh + py * 2))
  if (sw < 3 || sh < 3) return null

  const { ctx } = ctxOf(sw, sh)
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh)
  const crop = ctx.getImageData(0, 0, sw, sh)
  const D = crop.data

  // Local background: the median of the crop's border ring. The padding exists
  // precisely so this ring is ground rather than ink.
  const ring: [number[], number[], number[]] = [[], [], []]
  const band = Math.max(1, Math.round(Math.min(sw, sh) * 0.08))
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const edge = x < band || y < band || x >= sw - band || y >= sh - band
      if (!edge) continue
      const i = (y * sw + x) * 4
      ring[0].push(D[i])
      ring[1].push(D[i + 1])
      ring[2].push(D[i + 2])
    }
  }
  const bg = [median(ring[0]), median(ring[1]), median(ring[2])]

  // Distance from the local ground, normalised into a 0..255 field.
  const dist = new Uint8ClampedArray(sw * sh)
  const hist = new Array(256).fill(0)
  for (let p = 0; p < sw * sh; p++) {
    const i = p * 4
    const dr = D[i] - bg[0]
    const dg = D[i + 1] - bg[1]
    const db = D[i + 2] - bg[2]
    const d = Math.min(255, Math.sqrt(dr * dr + dg * dg + db * db) * 0.7)
    dist[p] = d
    hist[Math.round(d)]++
  }

  const t = Math.max(28, otsu(hist, sw * sh))

  const mask = new ImageData(sw, sh)
  const M = mask.data
  const reds: number[] = []
  const greens: number[] = []
  const blues: number[] = []

  let minX = sw
  let minY = sh
  let maxX = -1
  let maxY = -1
  let ink = 0

  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const p = y * sw + x
      if (dist[p] <= t) continue
      ink++
      const i = p * 4
      M[i] = M[i + 1] = M[i + 2] = 255
      M[i + 3] = 255
      // Only the solid core of a stroke carries the true colour; edges are blended.
      if (dist[p] > t * 1.5) {
        reds.push(D[i])
        greens.push(D[i + 1])
        blues.push(D[i + 2])
      }
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }

  if (maxX < 0) return null
  const density = ink / (sw * sh)
  // A split that claims almost nothing or almost everything did not find type.
  if (density < 0.004 || density > 0.75) return null

  const bw2 = maxX - minX + 1
  const bh2 = maxY - minY + 1

  // The glyphs themselves, alpha ramped across the distance field so the
  // antialiased rim of each stroke is preserved rather than clipped square.
  const cutLayer = ctxOf(bw2, bh2)
  const cutData = new ImageData(bw2, bh2)
  const C = cutData.data
  const soft = Math.max(8, t * 0.6)
  for (let y = 0; y < bh2; y++) {
    for (let x = 0; x < bw2; x++) {
      const sp = (y + minY) * sw + (x + minX)
      const dp = (y * bw2 + x) * 4
      const si = sp * 4
      const a = Math.min(1, Math.max(0, (dist[sp] - (t - soft)) / soft))
      C[dp] = D[si]
      C[dp + 1] = D[si + 1]
      C[dp + 2] = D[si + 2]
      C[dp + 3] = Math.round(a * 255)
    }
  }
  cutLayer.ctx.putImageData(cutData, 0, 0)

  const refLayer = ctxOf(sw, sh)
  refLayer.ctx.putImageData(crop, 0, 0)

  return {
    box: { x: sx + minX, y: sy + minY, w: bw2, h: bh2 },
    color: reds.length ? hex(median(reds), median(greens), median(blues)) : '#ffffff',
    mask,
    maskOrigin: { x: sx, y: sy },
    density,
    cut: cutLayer.canvas.toDataURL('image/png'),
    styleRef: refLayer.canvas.toDataURL('image/png'),
  }
}

// ------------------------------------------------------------------ fit

export type TextFit = {
  fontSize: number
  letterSpacing: number
  /** Layer box that lands the rendered ink exactly on the measured ink. */
  x: number
  y: number
  w: number
  h: number
}

function measure(
  ctx: CanvasRenderingContext2D,
  text: string,
  family: string,
  weight: number,
  italic: boolean,
  size: number,
  letterSpacing: number,
) {
  ctx.font = `${italic ? 'italic ' : ''}${weight} ${size}px ${fontStack(family)}`
  ctx.textBaseline = 'top'
  ctx.textAlign = 'left'
  // letterSpacing is a canvas property, not part of the font shorthand.
  ;(ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${letterSpacing}px`
  const m = ctx.measureText(text)
  return {
    inkW: m.actualBoundingBoxLeft + m.actualBoundingBoxRight,
    inkH: m.actualBoundingBoxAscent + m.actualBoundingBoxDescent,
    left: m.actualBoundingBoxLeft,
    ascent: m.actualBoundingBoxAscent,
  }
}

/**
 * Solve for the size and tracking that make the rendered ink box equal the
 * measured one, then back out the layer box that puts it in the right place.
 *
 * Matching ink box to ink box sidesteps baseline and cap-height semantics
 * entirely — both sides are defined by where the pixels actually are, so it
 * works the same for Latin and CJK.
 */
export function fitText(
  text: string,
  family: string,
  weight: number,
  italic: boolean,
  target: { x: number; y: number; w: number; h: number },
): TextFit {
  const { ctx } = ctxOf(8, 8)
  const probe = 100

  const base = measure(ctx, text, family, weight, italic, probe, 0)
  // Ink height scales linearly with font size, so one probe pins the scale.
  let size = base.inkH > 0 ? (probe * target.h) / base.inkH : target.h
  size = Math.min(Math.max(size, 4), 2000)

  // Tracking closes whatever width gap the face's own advances leave behind.
  const atSize = measure(ctx, text, family, weight, italic, size, 0)
  const gaps = Math.max(1, [...text].length - 1)
  let letterSpacing = (target.w - atSize.inkW) / gaps
  if (!Number.isFinite(letterSpacing)) letterSpacing = 0
  // Beyond about a third of an em the result stops reading as the same setting.
  letterSpacing = Math.min(size * 0.35, Math.max(-size * 0.15, letterSpacing))

  const final = measure(ctx, text, family, weight, italic, size, letterSpacing)

  return {
    fontSize: size,
    letterSpacing,
    // With textBaseline 'top' the ink sits below the alignment point, so the box
    // origin is the ink origin shifted back by the face's own bearings.
    x: target.x + final.left,
    y: target.y + final.ascent,
    w: Math.max(final.inkW, target.w) * 1.02,
    h: Math.max(final.inkH, target.h) * 1.6,
  }
}

// ---------------------------------------------------------- font choice

export type FontScore = {
  family: string
  weight: number
  score: number
  /** How well the face's own advances match the target width, before tracking. */
  widthFit: number
  /** Contour agreement — where faces actually differ from each other. */
  edgeIou: number
}

/** Morphological gradient: the one-pixel shell around the ink. */
function edgeBand(alpha: Uint8Array, w: number, h: number) {
  const out = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x
      if (!alpha[p]) continue
      const edge =
        x === 0 || y === 0 || x === w - 1 || y === h - 1 ||
        !alpha[p - 1] || !alpha[p + 1] || !alpha[p - w] || !alpha[p + w]
      if (edge) out[p] = 1
    }
  }
  return out
}

/**
 * Pick the face by rendering candidates and scoring them against the ink.
 *
 * Two signals, because either alone is misleading. Area overlap barely separates
 * faces — the strokes land in the same places and only the terminals differ — and
 * it collapses entirely once tracking has been used to force the width to match.
 * So width is scored BEFORE any tracking is applied, where a face's own advances
 * are one of the strongest signals available, and overlap is measured on the
 * contour shell rather than the filled area, which is where serifs live.
 *
 * Even so this is a weak identifier next to a trained font-recognition model.
 * The caller is expected to check `margin` and defer to the vision model's read
 * when the top two candidates are not meaningfully apart.
 */
export async function scoreFonts(
  text: string,
  candidates: { family: string; weight: number }[],
  ink: InkMetrics,
  italic: boolean,
): Promise<FontScore[]> {
  // Without this every candidate renders in the same fallback and the scoreboard
  // is noise — which reads as "cannot tell them apart" rather than as a failure.
  await ensureFonts(candidates, text)
  const target = ink.box
  const scores: FontScore[] = []

  const maskW = ink.mask.width
  const maskH = ink.mask.height
  const M = ink.mask.data
  const offX = target.x - ink.maskOrigin.x
  const offY = target.y - ink.maskOrigin.y

  // Target contour, cropped to the ink box.
  const tw = Math.max(1, Math.round(target.w))
  const th = Math.max(1, Math.round(target.h))
  const targetAlpha = new Uint8Array(tw * th)
  for (let y = 0; y < th; y++) {
    for (let x = 0; x < tw; x++) {
      const mx = x + offX
      const my = y + offY
      if (mx >= 0 && my >= 0 && mx < maskW && my < maskH && M[(my * maskW + mx) * 4 + 3] > 96) {
        targetAlpha[y * tw + x] = 1
      }
    }
  }
  const targetEdge = edgeBand(targetAlpha, tw, th)
  let targetEdgeCount = 0
  for (let i = 0; i < targetEdge.length; i++) targetEdgeCount += targetEdge[i]

  const probeCtx = ctxOf(8, 8).ctx

  for (const cand of candidates) {
    // Scale by height only — leaving width free so it can disagree, which is
    // exactly the evidence we want.
    const base = measure(probeCtx, text, cand.family, cand.weight, italic, 100, 0)
    const size = base.inkH > 0 ? (100 * target.h) / base.inkH : target.h
    const natural = measure(probeCtx, text, cand.family, cand.weight, italic, size, 0)
    const widthFit = target.w > 0 ? Math.max(0, 1 - Math.abs(natural.inkW - target.w) / target.w) : 0

    const { canvas, ctx } = ctxOf(tw, th)
    ctx.clearRect(0, 0, tw, th)
    ctx.fillStyle = '#fff'
    ctx.textBaseline = 'top'
    ctx.textAlign = 'left'
    ctx.font = `${italic ? 'italic ' : ''}${cand.weight} ${size}px ${fontStack(cand.family)}`
    ;(ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = '0px'
    ctx.fillText(text, natural.left, natural.ascent)

    const rendered = ctx.getImageData(0, 0, tw, th).data
    const candAlpha = new Uint8Array(tw * th)
    for (let p = 0; p < tw * th; p++) candAlpha[p] = rendered[p * 4 + 3] > 96 ? 1 : 0
    const candEdge = edgeBand(candAlpha, tw, th)

    let inter = 0
    let union = 0
    for (let p = 0; p < tw * th; p++) {
      const a = candEdge[p]
      const b = targetEdge[p]
      if (a || b) union++
      if (a && b) inter++
    }
    const edgeIou = union ? inter / union : 0
    void canvas

    scores.push({
      family: cand.family,
      weight: cand.weight,
      // Width carries more information than contour overlap at these sizes.
      score: widthFit * 0.6 + edgeIou * 0.4,
      widthFit,
      edgeIou,
    })
  }

  void targetEdgeCount
  return scores.sort((a, b) => b.score - a.score)
}

/** How decisively the winner beat the runner-up. Below ~0.06 the scores are
 *  noise and the vision model's read should be preferred. */
export function scoreMargin(scores: FontScore[]) {
  if (scores.length < 2) return 1
  return scores[0].score - scores[1].score
}

/** Faces the planner is allowed to name, and that the page actually loads. */
export const FONT_CANDIDATES: { family: string; weight: number }[] = [
  { family: 'Noto Sans SC', weight: 700 },
  { family: 'Noto Serif SC', weight: 700 },
  { family: 'Inter', weight: 700 },
  { family: 'Playfair Display', weight: 700 },
  { family: 'Space Grotesk', weight: 600 },
  { family: 'Bebas Neue', weight: 400 },
  { family: 'Georgia', weight: 700 },
]

// ------------------------------------------------------------- dedupe

/** Boxes are [y0,x0,y1,x1] on the 0..1000 grid. */
export function boxIou(a: [number, number, number, number], b: [number, number, number, number]) {
  const top = Math.max(a[0], b[0])
  const left = Math.max(a[1], b[1])
  const bottom = Math.min(a[2], b[2])
  const right = Math.min(a[3], b[3])
  if (bottom <= top || right <= left) return 0
  const inter = (bottom - top) * (right - left)
  const areaA = (a[2] - a[0]) * (a[3] - a[1])
  const areaB = (b[2] - b[0]) * (b[3] - b[1])
  return inter / (areaA + areaB - inter)
}

/**
 * Drop text runs that describe the same ink twice.
 *
 * The layout pass readily reports "V60杯" and "V60" as separate runs over the
 * same glyphs; rendering both stacks two layers on one spot and reads as ghosting.
 * Longer transcriptions win, since they are the more complete read.
 */
export function dedupeRuns<T extends { box: [number, number, number, number]; content: string }>(
  runs: T[],
  iouThreshold = 0.45,
): T[] {
  const kept: T[] = []
  const ordered = [...runs].sort((a, b) => b.content.length - a.content.length)

  for (const run of ordered) {
    const clash = kept.find((k) => boxIou(k.box, run.box) > iouThreshold)
    if (clash) continue
    kept.push(run)
  }
  return kept
}
