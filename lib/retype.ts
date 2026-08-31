'use client'

import { dualRenderMatte, imageSize } from './matte'
import type { ImageLayer } from './types'

/**
 * Rewrite a pixel text layer, keeping its lettering.
 *
 * The original crop goes back to the image model as a style reference, so the new
 * words arrive in the same hand. Rendered twice against known backdrops, because
 * type is almost all antialiased edge and difference matting is the only recovery
 * that holds up there — a hard key would leave every stroke fringed.
 */
export async function retypeLayer(
  layer: ImageLayer,
  nextText: string,
  opts: { model?: string; signal?: AbortSignal } = {},
): Promise<{ src: string; x: number; y: number; w: number; h: number; cost: number }> {
  if (!layer.retype) throw new Error('这个图层不是保留原始笔画的文字层')

  const { retypePrompt } = await import('./prompts')

  const call = async (backdrop: 'white' | 'black') => {
    const res = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: retypePrompt(nextText, backdrop),
        references: [layer.retype!.styleRef],
        aspectRatio: '16:9',
        model: opts.model,
      }),
      signal: opts.signal,
    })
    const json = await res.json()
    if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`)
    return json as { images: string[]; usage?: { cost: number } }
  }

  const [white, black] = await Promise.all([call('white'), call('black')])
  const matte = await dualRenderMatte(white.images[0], black.images[0])
  const size = await imageSize(matte.src)

  // Keep the run's cap height and its left edge; only the width follows the new
  // string, the way a line of type grows when you add words to it.
  const scale = layer.h / Math.max(1, size.height)

  return {
    src: matte.src,
    x: layer.x,
    y: layer.y,
    w: size.width * scale,
    h: layer.h,
    cost: (white.usage?.cost ?? 0) + (black.usage?.cost ?? 0),
  }
}
