import { NextResponse } from 'next/server'
import { generateImages } from '@/lib/openrouter'
import { erasePrompt } from '@/lib/prompts'
import { fail } from '@/lib/api-util'

export const runtime = 'nodejs'
// Vercel Hobby caps a function at 60s; every route here is a single model call.
export const maxDuration = 60

/** Pure-API inpainting: hand the flat image back to Nano Banana and ask it to lift
 *  the named elements out, reconstructing what was behind them. */
export async function POST(req: Request) {
  try {
    const body = await req.json()
    const image: string = String(body.image ?? '')
    if (!image.startsWith('data:') && !image.startsWith('http')) {
      return NextResponse.json({ error: 'image must be a data: URI or https URL' }, { status: 400 })
    }
    const targets: string[] = Array.isArray(body.targets) ? body.targets.map(String).filter(Boolean) : []

    const res = await generateImages({
      model: body.model || undefined,
      prompt: erasePrompt(targets),
      references: [image],
      aspectRatio: body.aspectRatio || undefined,
      resolution: body.resolution || undefined,
      outputFormat: 'png',
    })

    return NextResponse.json({ image: res.images[0], usage: res.usage, model: res.model })
  } catch (err) {
    return fail(err)
  }
}
