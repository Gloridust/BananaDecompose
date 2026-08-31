import { NextResponse } from 'next/server'
import { generateImages } from '@/lib/openrouter'
import { fail } from '@/lib/api-util'

export const runtime = 'nodejs'
// Vercel Hobby caps a function at 60s; every route here is a single model call.
export const maxDuration = 60

/** One image call per request. The client fans these out and drives the pipeline,
 *  which keeps every function well under the serverless time limit. */
export async function POST(req: Request) {
  try {
    const body = await req.json()
    const prompt: string = String(body.prompt ?? '').trim()
    if (!prompt) return NextResponse.json({ error: 'prompt is required' }, { status: 400 })

    const res = await generateImages({
      model: body.model || undefined,
      prompt,
      aspectRatio: body.aspectRatio || undefined,
      resolution: body.resolution || undefined,
      seed: typeof body.seed === 'number' ? body.seed : undefined,
      background: body.background === 'transparent' ? 'transparent' : undefined,
      references: Array.isArray(body.references) ? body.references : undefined,
      outputFormat: 'png',
    })

    return NextResponse.json({ images: res.images, usage: res.usage, model: res.model })
  } catch (err) {
    return fail(err)
  }
}
