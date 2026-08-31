'use client'

import { loadImage } from './matte'
import type { Layer, Scene } from './types'

export function download(filename: string, dataUrl: string) {
  const a = document.createElement('a')
  a.href = dataUrl
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
}

export function downloadJson(filename: string, value: unknown) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  download(filename, url)
  setTimeout(() => URL.revokeObjectURL(url), 4000)
}

export function fontStack(family: string) {
  return `"${family}", "Noto Sans SC", system-ui, -apple-system, "Segoe UI", sans-serif`
}

/** Flatten the scene back to a single raster — the "did we lose anything?" check. */
export async function sceneToPng(scene: Scene): Promise<string> {
  const canvas = document.createElement('canvas')
  canvas.width = scene.canvas.width
  canvas.height = scene.canvas.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 2D context unavailable')

  ctx.fillStyle = scene.canvas.background || '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  for (const layer of scene.layers) {
    if (!layer.visible) continue
    ctx.save()
    ctx.globalAlpha = layer.opacity
    if (layer.rotation) {
      ctx.translate(layer.x + layer.w / 2, layer.y + layer.h / 2)
      ctx.rotate((layer.rotation * Math.PI) / 180)
      ctx.translate(-(layer.x + layer.w / 2), -(layer.y + layer.h / 2))
    }

    if (layer.type === 'image') {
      try {
        const img = await loadImage(layer.src)
        ctx.drawImage(img, layer.x, layer.y, layer.w, layer.h)
      } catch {
        /* skip undecodable layer */
      }
    } else {
      ctx.fillStyle = layer.color
      ctx.textBaseline = 'top'
      ctx.textAlign = layer.align
      ctx.font = `${layer.italic ? 'italic ' : ''}${layer.fontWeight} ${layer.fontSize}px ${fontStack(layer.fontFamily)}`
      const anchorX = layer.align === 'center' ? layer.x + layer.w / 2 : layer.align === 'right' ? layer.x + layer.w : layer.x
      const lines = layer.text.split('\n')
      const lineHeight = layer.fontSize * layer.lineHeight
      lines.forEach((line, i) => {
        ctx.fillText(line, anchorX, layer.y + i * lineHeight)
      })
    }
    ctx.restore()
  }

  return canvas.toDataURL('image/png')
}

function esc(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function layerToSvg(layer: Layer): string {
  const transform = layer.rotation
    ? ` transform="rotate(${layer.rotation} ${layer.x + layer.w / 2} ${layer.y + layer.h / 2})"`
    : ''
  const opacity = layer.opacity < 1 ? ` opacity="${layer.opacity}"` : ''

  if (layer.type === 'image') {
    return `  <image id="${esc(layer.id)}" x="${layer.x}" y="${layer.y}" width="${layer.w}" height="${layer.h}" href="${layer.src}"${opacity}${transform}/>`
  }

  const anchor = layer.align === 'center' ? 'middle' : layer.align === 'right' ? 'end' : 'start'
  const anchorX = layer.align === 'center' ? layer.x + layer.w / 2 : layer.align === 'right' ? layer.x + layer.w : layer.x
  const lineHeight = layer.fontSize * layer.lineHeight
  const spans = layer.text
    .split('\n')
    .map((line, i) => `<tspan x="${anchorX}" dy="${i === 0 ? 0 : lineHeight}">${esc(line)}</tspan>`)
    .join('')

  return `  <text id="${esc(layer.id)}" x="${anchorX}" y="${layer.y + layer.fontSize * 0.82}" fill="${layer.color}" font-family="${esc(layer.fontFamily)}" font-size="${layer.fontSize}" font-weight="${layer.fontWeight}"${layer.italic ? ' font-style="italic"' : ''} letter-spacing="${layer.letterSpacing}" text-anchor="${anchor}"${opacity}${transform}>${spans}</text>`
}

/** SVG keeps text as <text> — the whole point of the exercise. */
export function sceneToSvg(scene: Scene): string {
  const body = scene.layers.filter((l) => l.visible).map(layerToSvg).join('\n')
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${scene.canvas.width}" height="${scene.canvas.height}" viewBox="0 0 ${scene.canvas.width} ${scene.canvas.height}">
  <rect width="100%" height="100%" fill="${scene.canvas.background || '#ffffff'}"/>
${body}
</svg>`
}

export function downloadSvg(filename: string, scene: Scene) {
  const blob = new Blob([sceneToSvg(scene)], { type: 'image/svg+xml' })
  const url = URL.createObjectURL(blob)
  download(filename, url)
  setTimeout(() => URL.revokeObjectURL(url), 4000)
}
