import { NextResponse } from 'next/server'
import { MODELS, chat, parseJson } from '@/lib/openrouter'
import { segmentPrompt } from '@/lib/prompts'
import { clampBox, fail } from '@/lib/api-util'

export const runtime = 'nodejs'
// Vercel Hobby caps a function at 60s; every route here is a single model call.
export const maxDuration = 60

type RawMask = { label?: string; box_2d?: number[]; mask?: string }

/** Gemini's native grounding: box_2d + a base64 PNG probability mask per object.
 *  Defaults to the grounding model slot because the Flash line does not document this. */
export async function POST(req: Request) {
  try {
    const body = await req.json()
    const image: string = String(body.image ?? '')
    const labels: string[] = Array.isArray(body.labels) ? body.labels.map(String).filter(Boolean) : []

    if (!image.startsWith('data:') && !image.startsWith('http')) {
      return NextResponse.json({ error: 'image must be a data: URI or https URL' }, { status: 400 })
    }
    if (!labels.length) return NextResponse.json({ error: 'labels is required' }, { status: 400 })

    const res = await chat({
      model: body.model || MODELS.grounding,
      text: segmentPrompt(labels),
      images: [image],
      temperature: 0,
    })

    let raw: RawMask[]
    try {
      const parsed = parseJson<RawMask[] | { masks?: RawMask[]; items?: RawMask[] }>(res.text)
      raw = Array.isArray(parsed) ? parsed : (parsed.masks ?? parsed.items ?? [])
    } catch {
      // Grounding output is free-form; a refusal to emit masks is a soft failure,
      // the caller falls back to plain box crops.
      return NextResponse.json({ masks: [], usage: res.usage, model: res.model, degraded: true })
    }

    const masks = raw
      .filter((m) => m && typeof m === 'object')
      .map((m, i) => ({
        label: String(m.label ?? labels[i] ?? `item-${i + 1}`),
        box: clampBox(m.box_2d),
        mask: typeof m.mask === 'string' ? m.mask.replace(/^data:image\/\w+;base64,/, '') : null,
      }))

    return NextResponse.json({
      masks,
      usage: res.usage,
      model: res.model,
      degraded: masks.every((m) => !m.mask),
    })
  } catch (err) {
    return fail(err)
  }
}
