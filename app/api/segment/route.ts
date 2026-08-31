import { NextResponse } from 'next/server'
import { MODELS, OpenRouterError, chat, parseJson } from '@/lib/openrouter'
import { segmentPrompt } from '@/lib/prompts'
import { clampBox, fail } from '@/lib/api-util'

export const runtime = 'nodejs'
// Vercel Hobby caps a function at 60s; every route here is a single model call.
export const maxDuration = 60

// Leave headroom under maxDuration so a slow mask degrades into a clean JSON
// answer the client can fall back from, instead of a platform-level 504.
const TIMEOUT_MS = 45_000

type RawMask = { label?: string; box_2d?: number[]; mask?: string }

/** Gemini's native grounding: box_2d + a base64 PNG probability mask, ONE object
 *  per request. Defaults to the grounding slot because the Flash line does not
 *  document this capability. */
export async function POST(req: Request) {
  try {
    const body = await req.json()
    const image: string = String(body.image ?? '')
    const label: string = String(body.label ?? '').trim()

    if (!image.startsWith('data:') && !image.startsWith('http')) {
      return NextResponse.json({ error: 'image must be a data: URI or https URL' }, { status: 400 })
    }
    if (!label) return NextResponse.json({ error: 'label is required' }, { status: 400 })

    let res: Awaited<ReturnType<typeof chat>>
    try {
      res = await chat({
        model: body.model || MODELS.grounding,
        text: segmentPrompt(label),
        images: [image],
        temperature: 0,
        maxTokens: 8_000,
        timeoutMs: TIMEOUT_MS,
      })
    } catch (err) {
      // A timeout here is expected often enough to be a normal outcome: the caller
      // falls back to a rectangular crop rather than losing the element entirely.
      if (err instanceof OpenRouterError && err.status === 504) {
        return NextResponse.json({ mask: null, box: null, degraded: true, reason: '掩码生成超时', usage: { cost: 0 } })
      }
      throw err
    }

    let raw: RawMask | undefined
    try {
      const parsed = parseJson<RawMask[] | RawMask>(res.text)
      raw = Array.isArray(parsed) ? parsed[0] : parsed
    } catch {
      return NextResponse.json({
        mask: null,
        box: null,
        degraded: true,
        reason: '模型未返回可解析的掩码',
        usage: res.usage,
        model: res.model,
      })
    }

    const mask = typeof raw?.mask === 'string' ? raw.mask.replace(/^data:image\/\w+;base64,/, '') : null

    return NextResponse.json({
      label,
      box: raw?.box_2d ? clampBox(raw.box_2d) : null,
      mask,
      degraded: !mask,
      reason: mask ? undefined : '模型只给了框，没给掩码',
      usage: res.usage,
      model: res.model,
    })
  } catch (err) {
    return fail(err)
  }
}
