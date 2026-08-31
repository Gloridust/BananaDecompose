'use client'

// Every alpha recovery strategy runs in the browser on a <canvas>. Nothing here
// touches the server: it keeps the serverless functions cheap and stateless, and
// it means the pixel maths is inspectable in devtools while comparing strategies.

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Failed to decode image'))
    img.src = src
  })
}

function ctxOf(w: number, h: number) {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(w))
  canvas.height = Math.max(1, Math.round(h))
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('Canvas 2D context unavailable')
  return { canvas, ctx }
}

async function dataOf(src: string, w?: number, h?: number) {
  const img = await loadImage(src)
  const width = w ?? img.naturalWidth
  const height = h ?? img.naturalHeight
  const { ctx } = ctxOf(width, height)
  ctx.drawImage(img, 0, 0, width, height)
  return ctx.getImageData(0, 0, width, height)
}

function toDataUrl(data: ImageData) {
  const { canvas, ctx } = ctxOf(data.width, data.height)
  ctx.putImageData(data, 0, 0)
  return canvas.toDataURL('image/png')
}

// ------------------------------------------------------- dual render

export type MatteResult = {
  /** RGBA PNG data URI, trimmed to the subject's bounds. */
  src: string
  /** Subject bounds inside the source frame, normalised 0..1. */
  bounds: { x: number; y: number; w: number; h: number }
  /** Fraction of pixels with meaningful alpha — a cheap quality signal. */
  coverage: number
}

/**
 * Solve for alpha from two renders of the same subject over known backdrops.
 *
 *   over white:  Cw = F + (1 - a)
 *   over black:  Cb = F
 *   =>           a  = 1 - (Cw - Cb)      and      colour = Cb / a
 *
 * F is premultiplied, so black gives the premultiplied colour directly. The two
 * renders are never bit-identical (the model is not deterministic), so per-channel
 * alphas get averaged and the extremes are snapped.
 */
export async function dualRenderMatte(
  whiteSrc: string,
  blackSrc: string,
  opts: { floor?: number; ceiling?: number } = {},
): Promise<MatteResult> {
  const floor = opts.floor ?? 0.06
  const ceiling = opts.ceiling ?? 0.94

  const white = await dataOf(whiteSrc)
  const black = await dataOf(blackSrc, white.width, white.height)

  // The whole method assumes the model actually rendered the two backdrops it
  // was asked for. It often does not — observed: a subject asked for on pure
  // black came back on white. Then Cw ≈ Cb, alpha solves to 1 everywhere, and
  // the result is an opaque rectangle with no error anywhere. Checking the
  // corners costs nothing and turns that silent write-off into a reported one.
  const check = backdropCheck(white, black)
  if (!check.usable) {
    throw new MatteError(check.reason, check)
  }

  const out = new ImageData(white.width, white.height)
  const W = white.data
  const B = black.data
  const O = out.data

  for (let i = 0; i < W.length; i += 4) {
    const ar = 1 - (W[i] - B[i]) / 255
    const ag = 1 - (W[i + 1] - B[i + 1]) / 255
    const ab = 1 - (W[i + 2] - B[i + 2]) / 255

    let a = (ar + ag + ab) / 3
    if (a < floor) a = 0
    else if (a > ceiling) a = 1
    else a = Math.min(1, Math.max(0, a))

    if (a === 0) {
      O[i] = O[i + 1] = O[i + 2] = O[i + 3] = 0
      continue
    }
    // Un-premultiply. Averaging the two renders cancels a little of the drift
    // between them where the subject is fully opaque.
    const inv = 1 / a
    O[i] = Math.min(255, B[i] * inv)
    O[i + 1] = Math.min(255, B[i + 1] * inv)
    O[i + 2] = Math.min(255, B[i + 2] * inv)
    O[i + 3] = Math.round(a * 255)
  }

  return trim(out)
}

// -------------------------------------------------------- chroma key

export class MatteError extends Error {
  constructor(message: string, readonly detail: BackdropCheck) {
    super(message)
    this.name = 'MatteError'
  }
}

export type BackdropCheck = {
  usable: boolean
  reason: string
  whiteLuma: number
  blackLuma: number
  separation: number
}

/** Median luma of the frame's corners, where the backdrop should be showing. */
function cornerLuma(data: ImageData) {
  const { width, height, data: D } = data
  const size = Math.max(4, Math.round(Math.min(width, height) * 0.06))
  const samples: number[] = []

  for (const [ox, oy] of [
    [0, 0],
    [width - size, 0],
    [0, height - size],
    [width - size, height - size],
  ]) {
    for (let y = oy; y < oy + size; y += 2) {
      for (let x = ox; x < ox + size; x += 2) {
        const i = (y * width + x) * 4
        samples.push((D[i] * 0.299 + D[i + 1] * 0.587 + D[i + 2] * 0.114) / 255)
      }
    }
  }
  samples.sort((a, b) => a - b)
  return samples[Math.floor(samples.length / 2)] ?? 0
}

function backdropCheck(white: ImageData, black: ImageData): BackdropCheck {
  const whiteLuma = cornerLuma(white)
  const blackLuma = cornerLuma(black)
  const separation = whiteLuma - blackLuma

  // Two obedient renders separate by nearly the full range; anything under half
  // means at least one backdrop is not what was asked for, and the solved alpha
  // would be meaningless.
  if (separation < 0.5) {
    const culprit =
      whiteLuma < 0.75 && blackLuma < 0.25
        ? '白底那张不是白的'
        : whiteLuma > 0.75 && blackLuma > 0.25
          ? '黑底那张不是黑的'
          : '两张底色都不对'
    return {
      usable: false,
      reason: `双渲染底色校验失败：${culprit}（白底亮度 ${whiteLuma.toFixed(2)}，黑底亮度 ${blackLuma.toFixed(2)}，需要相差 0.5 以上）。模型没按指令换底，解出的 alpha 会是整块不透明。`,
      whiteLuma,
      blackLuma,
      separation,
    }
  }
  return { usable: true, reason: '', whiteLuma, blackLuma, separation }
}

/** Distance-based key with spill suppression. Default key is pure magenta. */
export async function chromaKeyMatte(
  src: string,
  opts: { key?: [number, number, number]; near?: number; far?: number } = {},
): Promise<MatteResult> {
  const [kr, kg, kb] = opts.key ?? [255, 0, 255]
  const near = opts.near ?? 90 // fully keyed at or below this distance
  const far = opts.far ?? 180 // fully opaque at or above this distance

  const data = await dataOf(src)
  const D = data.data

  for (let i = 0; i < D.length; i += 4) {
    const dr = D[i] - kr
    const dg = D[i + 1] - kg
    const db = D[i + 2] - kb
    const dist = Math.sqrt(dr * dr + dg * dg + db * db)

    let a = (dist - near) / (far - near)
    a = Math.min(1, Math.max(0, a))

    if (a === 0) {
      D[i] = D[i + 1] = D[i + 2] = D[i + 3] = 0
      continue
    }
    // Despill: on a magenta key the giveaway is red+blue running ahead of green.
    if (a < 1) {
      const g = D[i + 1]
      const cap = g + (255 - g) * a
      if (kr > kg) D[i] = Math.min(D[i], cap)
      if (kb > kg) D[i + 2] = Math.min(D[i + 2], cap)
    }
    D[i + 3] = Math.round(a * 255)
  }

  return trim(data)
}

// --------------------------------------------------------- VLM masks

/**
 * Apply a model-produced probability mask. The mask is box-local: it covers only
 * the object's box_2d crop, so it gets stretched to that crop before use.
 */
export async function maskMatte(
  src: string,
  maskBase64: string | null,
  box: [number, number, number, number],
  opts: { threshold?: number } = {},
): Promise<MatteResult> {
  const threshold = opts.threshold ?? 0.5
  const img = await loadImage(src)
  const W = img.naturalWidth
  const H = img.naturalHeight

  const [y0, x0, y1, x1] = box
  const sx = Math.round((x0 / 1000) * W)
  const sy = Math.round((y0 / 1000) * H)
  const sw = Math.max(1, Math.round(((x1 - x0) / 1000) * W))
  const sh = Math.max(1, Math.round(((y1 - y0) / 1000) * H))

  const { ctx } = ctxOf(sw, sh)
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh)
  const crop = ctx.getImageData(0, 0, sw, sh)

  if (!maskBase64) {
    // No mask came back — fall back to the rectangular crop. Still trim, so a
    // source that *does* carry alpha (the 'native' strategy) gets hugged properly;
    // on an opaque crop trim() is a no-op.
    const t = trim(crop)
    return {
      src: t.src,
      bounds: {
        x: (sx + t.bounds.x * sw) / W,
        y: (sy + t.bounds.y * sh) / H,
        w: (t.bounds.w * sw) / W,
        h: (t.bounds.h * sh) / H,
      },
      coverage: t.coverage,
    }
  }

  const maskData = await dataOf(`data:image/png;base64,${maskBase64}`, sw, sh)
  const C = crop.data
  const M = maskData.data
  let solid = 0

  for (let i = 0; i < C.length; i += 4) {
    const p = (M[i] + M[i + 1] + M[i + 2]) / 3 / 255
    const a = p < threshold ? 0 : Math.min(1, (p - threshold) / (1 - threshold) + p)
    if (a <= 0) {
      C[i] = C[i + 1] = C[i + 2] = C[i + 3] = 0
    } else {
      C[i + 3] = Math.round(Math.min(1, a) * 255)
      solid++
    }
  }

  const trimmed = trim(crop)
  return {
    src: trimmed.src,
    bounds: {
      x: (sx + trimmed.bounds.x * sw) / W,
      y: (sy + trimmed.bounds.y * sh) / H,
      w: (trimmed.bounds.w * sw) / W,
      h: (trimmed.bounds.h * sh) / H,
    },
    coverage: solid / (sw * sh),
  }
}

// ------------------------------------------------------------- utils

/** Crop away fully transparent margins so the layer's box hugs the subject. */
function trim(data: ImageData): MatteResult {
  const { width, height, data: D } = data
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  let solid = 0

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (D[(y * width + x) * 4 + 3] > 8) {
        solid++
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }

  if (maxX < 0) {
    return { src: toDataUrl(data), bounds: { x: 0, y: 0, w: 1, h: 1 }, coverage: 0 }
  }

  const w = maxX - minX + 1
  const h = maxY - minY + 1
  const { canvas, ctx } = ctxOf(w, h)
  const src = ctxOf(width, height)
  src.ctx.putImageData(data, 0, 0)
  ctx.drawImage(src.canvas, minX, minY, w, h, 0, 0, w, h)

  return {
    src: canvas.toDataURL('image/png'),
    bounds: { x: minX / width, y: minY / height, w: w / width, h: h / height },
    coverage: solid / (width * height),
  }
}

/** Rectangular crop by a 0..1000 box — the no-mask fallback for pipeline B. */
export async function cropBox(src: string, box: [number, number, number, number]) {
  return maskMatte(src, null, box)
}

export async function downscale(src: string, maxDim: number): Promise<string> {
  const img = await loadImage(src)
  const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight))
  if (scale >= 1) return src
  const { canvas, ctx } = ctxOf(img.naturalWidth * scale, img.naturalHeight * scale)
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/png')
}

export async function thumbnail(src: string, size = 320): Promise<string> {
  const img = await loadImage(src)
  const scale = Math.min(1, size / Math.max(img.naturalWidth, img.naturalHeight))
  const { canvas, ctx } = ctxOf(img.naturalWidth * scale, img.naturalHeight * scale)
  ctx.fillStyle = '#0b0b0d'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/jpeg', 0.72)
}

/**
 * Patch one image into another through a feathered rect mask.
 *
 * The erase call regenerates the whole frame, so its output drifts everywhere —
 * colours shift, edges move, detail is reinvented. Taking the erased pixels only
 * where something was actually lifted, and the original everywhere else, keeps
 * the untouched parts of the plate bit-identical to what the model first drew.
 */
export async function compositeMasked(
  baseSrc: string,
  patchSrc: string,
  regions: { x: number; y: number; w: number; h: number }[],
  opts: { dilate?: number; feather?: number } = {},
): Promise<string> {
  if (!regions.length) return baseSrc

  const dilate = opts.dilate ?? 6
  const feather = opts.feather ?? 5

  const base = await loadImage(baseSrc)
  const W = base.naturalWidth
  const H = base.naturalHeight

  const patch = await loadImage(patchSrc)

  // Mask: white where the patch should win, blurred so the seam is not visible.
  const maskLayer = ctxOf(W, H)
  maskLayer.ctx.filter = `blur(${feather}px)`
  maskLayer.ctx.fillStyle = '#fff'
  for (const r of regions) {
    maskLayer.ctx.fillRect(r.x - dilate, r.y - dilate, r.w + dilate * 2, r.h + dilate * 2)
  }
  maskLayer.ctx.filter = 'none'

  // Cut the patch down to the mask.
  const patchLayer = ctxOf(W, H)
  patchLayer.ctx.drawImage(patch, 0, 0, W, H)
  patchLayer.ctx.globalCompositeOperation = 'destination-in'
  patchLayer.ctx.drawImage(maskLayer.canvas, 0, 0)
  patchLayer.ctx.globalCompositeOperation = 'source-over'

  const out = ctxOf(W, H)
  out.ctx.drawImage(base, 0, 0, W, H)
  out.ctx.drawImage(patchLayer.canvas, 0, 0)
  return out.canvas.toDataURL('image/png')
}

/**
 * Ramp the alpha down at the border.
 *
 * A regenerated patch is opaque to its own edge, and dropping that straight onto
 * a composition leaves a visible rectangle even when the content matches. Fading
 * the last few pixels lets the patch dissolve into what it is covering.
 */
export async function featherEdges(src: string, px = 12): Promise<string> {
  const img = await loadImage(src)
  const w = img.naturalWidth
  const h = img.naturalHeight
  const band = Math.max(2, Math.min(px, Math.floor(Math.min(w, h) / 4)))

  const { canvas, ctx } = ctxOf(w, h)
  ctx.drawImage(img, 0, 0)
  const data = ctx.getImageData(0, 0, w, h)
  const D = data.data

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const edge = Math.min(x, y, w - 1 - x, h - 1 - y)
      if (edge >= band) continue
      const a = edge / band
      const i = (y * w + x) * 4
      D[i + 3] = Math.round(D[i + 3] * a * a * (3 - 2 * a)) // smoothstep
    }
  }

  ctx.putImageData(data, 0, 0)
  return canvas.toDataURL('image/png')
}

/** Crop a region and scale it up, so a vision model sees the glyphs large. */
export async function cropAndZoom(
  src: string,
  box: { x: number; y: number; w: number; h: number },
  opts: { pad?: number; minDim?: number; maxDim?: number } = {},
): Promise<string> {
  const pad = opts.pad ?? 0.25
  const minDim = opts.minDim ?? 320
  const maxDim = opts.maxDim ?? 768

  const img = await loadImage(src)
  const px = box.w * pad
  const py = box.h * pad
  const sx = Math.max(0, Math.round(box.x - px))
  const sy = Math.max(0, Math.round(box.y - py))
  const sw = Math.min(img.naturalWidth - sx, Math.round(box.w + px * 2))
  const sh = Math.min(img.naturalHeight - sy, Math.round(box.h + py * 2))
  if (sw < 2 || sh < 2) return src

  const longest = Math.max(sw, sh)
  const scale = Math.min(maxDim / longest, Math.max(1, minDim / longest))
  const { canvas, ctx } = ctxOf(sw * scale, sh * scale)
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/png')
}

export async function imageSize(src: string) {
  const img = await loadImage(src)
  return { width: img.naturalWidth, height: img.naturalHeight }
}

export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('Failed to read file'))
    reader.readAsDataURL(file)
  })
}
