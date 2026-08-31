import { NextResponse } from 'next/server'
import { OpenRouterError } from './openrouter'

export function fail(err: unknown) {
  if (err instanceof OpenRouterError) {
    return NextResponse.json({ error: err.message, status: err.status }, { status: err.status >= 400 && err.status < 600 ? err.status : 502 })
  }
  const message = err instanceof Error ? err.message : String(err)
  return NextResponse.json({ error: message }, { status: 500 })
}

export function clampBox(box: unknown): [number, number, number, number] {
  const arr = Array.isArray(box) ? box.map(Number) : []
  const [y0, x0, y1, x1] = [arr[0] ?? 0, arr[1] ?? 0, arr[2] ?? 1000, arr[3] ?? 1000]
  const c = (n: number) => Math.min(1000, Math.max(0, Number.isFinite(n) ? n : 0))
  const ty = Math.min(c(y0), c(y1))
  const by = Math.max(c(y0), c(y1))
  const lx = Math.min(c(x0), c(x1))
  const rx = Math.max(c(x0), c(x1))
  return [ty, lx, Math.max(by, ty + 1), Math.max(rx, lx + 1)]
}
