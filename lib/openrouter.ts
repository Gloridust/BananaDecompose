import 'server-only'

const BASE = 'https://openrouter.ai/api/v1'

export const MODELS = {
  image: process.env.OPENROUTER_IMAGE_MODEL || 'google/gemini-3.1-flash-image',
  vision: process.env.OPENROUTER_VISION_MODEL || 'google/gemini-3.7-flash',
  grounding: process.env.OPENROUTER_GROUNDING_MODEL || 'google/gemini-3.1-pro-preview',
}

export class OpenRouterError extends Error {
  constructor(message: string, readonly status: number, readonly body?: unknown) {
    super(message)
    this.name = 'OpenRouterError'
  }
}

function headers() {
  const key = process.env.OPENROUTER_API_KEY
  if (!key) {
    throw new OpenRouterError(
      'OPENROUTER_API_KEY is not set. Copy .env.local.example to .env.local and add your key.',
      500,
    )
  }
  const h: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  }
  if (process.env.OPENROUTER_SITE_URL) h['HTTP-Referer'] = process.env.OPENROUTER_SITE_URL
  if (process.env.OPENROUTER_SITE_NAME) h['X-Title'] = process.env.OPENROUTER_SITE_NAME
  return h
}

async function post(path: string, body: unknown, timeoutMs = 170_000) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    const text = await res.text()
    let json: any
    try {
      json = JSON.parse(text)
    } catch {
      throw new OpenRouterError(`Non-JSON response from ${path}: ${text.slice(0, 400)}`, res.status)
    }
    if (!res.ok || json?.error) {
      const msg = json?.error?.message || json?.message || `HTTP ${res.status}`
      throw new OpenRouterError(msg, res.status, json)
    }
    return json
  } catch (err) {
    if (err instanceof OpenRouterError) throw err
    if ((err as Error)?.name === 'AbortError') {
      throw new OpenRouterError(`Request to ${path} timed out after ${timeoutMs}ms`, 504)
    }
    throw new OpenRouterError((err as Error).message, 502)
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------- images

export type ImageCall = {
  model?: string
  prompt: string
  n?: number
  aspectRatio?: string
  resolution?: string
  seed?: number
  background?: 'transparent' | 'opaque'
  outputFormat?: 'png' | 'jpeg' | 'webp'
  /** data: URIs or https URLs */
  references?: string[]
}

export async function generateImages(call: ImageCall) {
  const body: Record<string, unknown> = {
    model: call.model || MODELS.image,
    prompt: call.prompt,
    output_format: call.outputFormat || 'png',
  }
  if (call.n && call.n > 1) body.n = call.n
  if (call.aspectRatio) body.aspect_ratio = call.aspectRatio
  if (call.resolution) body.resolution = call.resolution
  if (typeof call.seed === 'number') body.seed = call.seed
  if (call.background) body.background = call.background
  if (call.references?.length) {
    body.input_references = call.references.map((url) => ({
      type: 'image_url',
      image_url: { url },
    }))
  }

  const json = await post('/images', body)
  const data: any[] = json?.data ?? []
  const images = data
    .map((d) => {
      if (d?.b64_json) return `data:${d.media_type || 'image/png'};base64,${d.b64_json}`
      if (d?.url) return d.url as string
      return null
    })
    .filter((x): x is string => Boolean(x))

  if (!images.length) {
    throw new OpenRouterError('Image endpoint returned no image data', 502, json)
  }

  return {
    images,
    usage: { cost: Number(json?.usage?.cost ?? 0), tokens: Number(json?.usage?.total_tokens ?? 0) },
    model: String(body.model),
  }
}

// ------------------------------------------------------- chat / vision

export type ChatCall = {
  model?: string
  system?: string
  text: string
  /** data: URIs or https URLs */
  images?: string[]
  /** JSON schema for structured output. */
  schema?: { name: string; schema: Record<string, unknown> }
  maxTokens?: number
  temperature?: number
}

export async function chat(call: ChatCall) {
  const content: any[] = [{ type: 'text', text: call.text }]
  for (const url of call.images ?? []) {
    content.push({ type: 'image_url', image_url: { url } })
  }

  const messages: any[] = []
  if (call.system) messages.push({ role: 'system', content: call.system })
  messages.push({ role: 'user', content })

  const body: Record<string, unknown> = {
    model: call.model || MODELS.vision,
    messages,
    max_tokens: call.maxTokens ?? 32_000,
    temperature: call.temperature ?? 0.2,
  }
  if (call.schema) {
    body.response_format = {
      type: 'json_schema',
      json_schema: { name: call.schema.name, strict: true, schema: call.schema.schema },
    }
  }

  const json = await post('/chat/completions', body)
  const text: string = json?.choices?.[0]?.message?.content ?? ''
  return {
    text,
    usage: { cost: Number(json?.usage?.cost ?? 0), tokens: Number(json?.usage?.total_tokens ?? 0) },
    model: String(body.model),
  }
}

/** Models sometimes wrap JSON in prose or a fence even under json_schema. */
export function parseJson<T>(raw: string): T {
  const trimmed = raw.trim()
  const candidates = [trimmed]

  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) candidates.push(fence[1].trim())

  const firstBrace = trimmed.indexOf('{')
  const lastBrace = trimmed.lastIndexOf('}')
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1))
  }

  for (const c of candidates) {
    try {
      return JSON.parse(c) as T
    } catch {
      /* try next */
    }
  }
  throw new OpenRouterError(`Model did not return parseable JSON: ${trimmed.slice(0, 400)}`, 502)
}
