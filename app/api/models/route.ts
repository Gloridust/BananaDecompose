import { NextResponse } from 'next/server'
import { MODELS } from '@/lib/openrouter'

export const runtime = 'nodejs'

/** Lets the UI show which slots are wired up without ever exposing the key. */
export async function GET() {
  return NextResponse.json({
    configured: Boolean(process.env.OPENROUTER_API_KEY),
    models: MODELS,
  })
}
