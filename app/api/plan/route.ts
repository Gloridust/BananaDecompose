import { NextResponse } from 'next/server'
import { chat, parseJson } from '@/lib/openrouter'
import { PLAN_SCHEMA, PLAN_SYSTEM, planPrompt } from '@/lib/prompts'
import { clampBox, fail } from '@/lib/api-util'
import type { ScenePlan } from '@/lib/types'

export const runtime = 'nodejs'
// Vercel Hobby caps a function at 60s; every route here is a single model call.
export const maxDuration = 60

export async function POST(req: Request) {
  try {
    const body = await req.json()
    const prompt: string = String(body.prompt ?? '').trim()
    if (!prompt) return NextResponse.json({ error: 'prompt is required' }, { status: 400 })

    const width = Number(body.width) || 1024
    const height = Number(body.height) || 1024
    const maxElements = Math.min(12, Math.max(1, Number(body.maxElements) || 5))
    const liveText = body.textStrategy !== 'baked'

    const res = await chat({
      model: body.model || undefined,
      system: PLAN_SYSTEM,
      text: planPrompt(prompt, { maxElements, liveText, width, height }),
      schema: PLAN_SCHEMA as any,
      temperature: 0.7,
    })

    const plan = parseJson<ScenePlan>(res.text)
    plan.canvas = { width, height }
    plan.elements = (plan.elements ?? []).slice(0, maxElements).map((e, i) => ({
      ...e,
      id: e.id || `el-${i + 1}`,
      box: clampBox(e.box),
      z: Number.isFinite(e.z) ? e.z : i,
    }))
    plan.texts = (plan.texts ?? []).map((t, i) => ({
      ...t,
      id: t.id || `tx-${i + 1}`,
      box: clampBox(t.box),
      z: Number.isFinite(t.z) ? t.z : 100 + i,
    }))

    return NextResponse.json({ plan, usage: res.usage, model: res.model })
  } catch (err) {
    return fail(err)
  }
}
