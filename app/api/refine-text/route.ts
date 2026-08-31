import { NextResponse } from 'next/server'
import { chat, parseJson } from '@/lib/openrouter'
import { REFINE_SCHEMA, refinePrompt } from '@/lib/prompts'
import { fail } from '@/lib/api-util'

export const runtime = 'nodejs'
// Vercel Hobby caps a function at 60s; every route here is a single model call.
export const maxDuration = 60

type Refined = { content?: string; fontFamily?: string; fontWeight?: number; italic?: boolean; isText?: boolean }

/**
 * Re-read one text run from a zoomed crop.
 *
 * The whole-image pass has to resolve every run at once, so small type comes back
 * approximate. A crop where the glyphs fill the frame is read far more reliably —
 * and it is cheap, a couple of hundred input tokens on the Flash tier.
 *
 * Geometry is deliberately not requested. The caller measures that from pixels,
 * which a coordinate regression cannot beat.
 */
export async function POST(req: Request) {
  try {
    const body = await req.json()
    const image: string = String(body.image ?? '')
    const hint: string = String(body.hint ?? '')

    if (!image.startsWith('data:') && !image.startsWith('http')) {
      return NextResponse.json({ error: 'image must be a data: URI or https URL' }, { status: 400 })
    }

    const res = await chat({
      model: body.model || undefined,
      text: refinePrompt(hint),
      images: [image],
      schema: REFINE_SCHEMA as any,
      temperature: 0,
      maxTokens: 2_000,
      timeoutMs: 40_000,
    })

    let refined: Refined
    try {
      refined = parseJson<Refined>(res.text)
    } catch {
      return NextResponse.json({ refined: null, degraded: true, usage: res.usage, model: res.model })
    }

    return NextResponse.json({ refined, usage: res.usage, model: res.model })
  } catch (err) {
    return fail(err)
  }
}
