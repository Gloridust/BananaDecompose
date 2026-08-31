import { NextResponse } from 'next/server'
import { chat, parseJson } from '@/lib/openrouter'
import { ANALYZE_SCHEMA, ANALYZE_SYSTEM, analyzePrompt } from '@/lib/prompts'
import { clampBox, fail } from '@/lib/api-util'
import type { SceneAnalysis } from '@/lib/types'

export const runtime = 'nodejs'
// Vercel Hobby caps a function at 60s; every route here is a single model call.
export const maxDuration = 60

export async function POST(req: Request) {
  try {
    const body = await req.json()
    const image: string = String(body.image ?? '')
    if (!image.startsWith('data:') && !image.startsWith('http')) {
      return NextResponse.json({ error: 'image must be a data: URI or https URL' }, { status: 400 })
    }

    const width = Number(body.width) || 1024
    const height = Number(body.height) || 1024
    const maxElements = Math.min(16, Math.max(1, Number(body.maxElements) || 6))

    const res = await chat({
      model: body.model || undefined,
      system: ANALYZE_SYSTEM,
      text: analyzePrompt({ maxElements, width, height }),
      images: [image],
      schema: ANALYZE_SCHEMA as any,
      temperature: 0.1,
    })

    const analysis = parseJson<SceneAnalysis>(res.text)
    analysis.canvas = { width, height }
    analysis.elements = (analysis.elements ?? [])
      .slice(0, maxElements)
      .map((e, i) => ({ ...e, id: e.id || `el-${i + 1}`, box: clampBox(e.box), z: Number.isFinite(e.z) ? e.z : i }))
      .sort((a, b) => a.z - b.z)
    analysis.texts = (analysis.texts ?? []).map((t, i) => ({
      ...t,
      id: t.id || `tx-${i + 1}`,
      box: clampBox(t.box),
      z: Number.isFinite(t.z) ? t.z : 100 + i,
    }))

    return NextResponse.json({ analysis, usage: res.usage, model: res.model })
  } catch (err) {
    return fail(err)
  }
}
