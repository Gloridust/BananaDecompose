/** Shared rule: keep glyphs out of the raster so text stays a real text node. */
const NO_TEXT_RULE = `Absolutely no lettering, words, numbers, captions, watermarks, logos with type, or any written glyphs anywhere in the image. If the concept implies text, render the empty container or surface instead and leave that area visually clean and uncluttered.`

// ---------------------------------------------------------------- plan

export const PLAN_SYSTEM = `You are an art director who specifies layered design compositions.
You never produce images. You produce a structured plan that a rendering pipeline will
execute layer by layer, so every element must be independently renderable in isolation
against a plain backdrop.`

export function planPrompt(userPrompt: string, opts: { maxElements: number; liveText: boolean; width: number; height: number }) {
  return `Design a layered composition for this brief:

"""
${userPrompt}
"""

Canvas is ${opts.width}x${opts.height} pixels.

Return a plan with:

1. background — a prompt for a single full-bleed background plate. It must describe only
   the setting/backdrop/gradient/texture. No focal subjects, no props that belong on top,
   and no text. Also give its dominant colour as a hex string.

2. elements — at most ${opts.maxElements} foreground subjects/props, ordered back to front (z ascending).
   For each one write a "prompt" that describes THAT OBJECT ALONE, isolated, centred, full view,
   nothing else in frame, no background scenery, no ground shadow baked in, no cropping.
   Write it as a standalone image prompt — the renderer never sees the brief, only this string.
   Give a "box" as [y0, x0, y1, x1] with every value normalised to 0..1000 describing where the
   element sits on the canvas. Boxes may overlap; that is what z-order is for.

3. texts — every piece of copy the design calls for, as ${
    opts.liveText
      ? 'live text layers. These are NEVER rendered into any raster — the pipeline draws them as real text nodes, so specify them precisely'
      : 'text layers (this run bakes them into the raster later, but still specify them)'
  }.
   For each: content, box in the same 0..1000 convention, a hex colour with strong contrast
   against what sits behind it, a widely-available web font family (Inter, Georgia, Playfair Display,
   Space Grotesk, Bebas Neue, Noto Sans SC, Noto Serif SC, system-ui), numeric weight (100..900),
   font size in PIXELS relative to the ${opts.height}px-tall canvas, and alignment.
   If the brief is in Chinese, prefer "Noto Sans SC" or "Noto Serif SC".

${NO_TEXT_RULE}

Reserve visual breathing room where text layers will sit: the background and elements should
not put busy detail or clashing colour under a text box.`
}

export const PLAN_SCHEMA = {
  name: 'scene_plan',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['canvas', 'background', 'elements', 'texts'],
    properties: {
      canvas: {
        type: 'object',
        additionalProperties: false,
        required: ['width', 'height'],
        properties: { width: { type: 'integer' }, height: { type: 'integer' } },
      },
      background: {
        type: 'object',
        additionalProperties: false,
        required: ['prompt', 'dominantColor'],
        properties: { prompt: { type: 'string' }, dominantColor: { type: 'string' } },
      },
      elements: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'name', 'prompt', 'box', 'z'],
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            prompt: { type: 'string' },
            box: { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4 },
            z: { type: 'integer' },
          },
        },
      },
      texts: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'content', 'box', 'color', 'fontFamily', 'fontWeight', 'fontSize', 'align', 'z'],
          properties: {
            id: { type: 'string' },
            content: { type: 'string' },
            box: { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4 },
            color: { type: 'string' },
            fontFamily: { type: 'string' },
            fontWeight: { type: 'integer' },
            fontSize: { type: 'number' },
            align: { type: 'string', enum: ['left', 'center', 'right'] },
            z: { type: 'integer' },
          },
        },
      },
    },
  },
} as const

// ------------------------------------------------------------- render

export function backgroundPrompt(p: string) {
  return `${p}\n\nFull-bleed background plate only. ${NO_TEXT_RULE}`
}

export function elementPrompt(p: string, backdrop: 'white' | 'black' | 'magenta' | 'grey') {
  const backdropText: Record<typeof backdrop, string> = {
    white: 'Place it on a completely flat, uniform PURE WHITE (#FFFFFF) background that fills the entire frame edge to edge.',
    black: 'Place it on a completely flat, uniform PURE BLACK (#000000) background that fills the entire frame edge to edge.',
    magenta: 'Place it on a completely flat, uniform PURE MAGENTA (#FF00FF) background that fills the entire frame edge to edge. No magenta anywhere on the subject itself.',
    grey: 'Place it on a completely flat, uniform NEUTRAL GREY (#808080) background that fills the entire frame edge to edge.',
  }

  return `${p}

One single isolated subject, centred, fully visible, not cropped by the frame, with a small even margin on all sides.
${backdropText[backdrop]}
The backdrop must be perfectly uniform — no gradient, no vignette, no texture, no cast shadow, no reflection, no contact shadow on the ground.
Keep the subject's own lighting, colour and edge detail identical regardless of the backdrop colour.
${NO_TEXT_RULE}`
}

/** Pipeline A's "baked" control arm, and pipeline B's source image. */
export function flatPrompt(userPrompt: string, withText: boolean) {
  return withText
    ? `${userPrompt}\n\nA single finished, flattened design composition. Render any text crisply and legibly as part of the artwork.`
    : `${userPrompt}\n\nA single finished, flattened design composition. ${NO_TEXT_RULE}`
}

// ------------------------------------------------------------ analyse

export const ANALYZE_SYSTEM = `You are a design-file archaeologist. Given a flattened raster
image, you recover the layer structure a designer would have used to build it: what discrete
elements exist, where they sit, what order they stack in, and every piece of type with its
styling. You are precise about coordinates and you never invent elements that are not visible.`

export function analyzePrompt(opts: { maxElements: number; width: number; height: number }) {
  return `Recover the editable layer structure of this ${opts.width}x${opts.height} image.

Report every coordinate as "box": [y0, x0, y1, x1], normalised to 0..1000 over the full image.

1. background — describe the backdrop that would remain if every foreground element and every
   piece of text were lifted off, plus its dominant colour as hex.

2. elements — at most ${opts.maxElements} discrete, separable, non-text visual objects, ordered back to front
   (z ascending, 0 = closest to the background). Split things a designer would keep on separate
   layers; do not merge two objects into one box, and do not emit a box that covers the whole canvas.
   Give each a short human-readable label.

3. texts — every readable run of type, one entry per visually distinct line or block.
   Transcribe the content EXACTLY, preserving case, punctuation and language.
   Estimate: hex colour sampled from the glyph strokes, the closest widely-available web font family
   (Inter, Georgia, Playfair Display, Space Grotesk, Bebas Neue, Noto Sans SC, Noto Serif SC, system-ui),
   numeric weight 100..900, whether it is italic, the cap height in PIXELS on this ${opts.height}px-tall
   canvas, and alignment. The box must tightly wrap the glyphs, not the padded area around them.

Be exhaustive about text — missed type is the single biggest failure of this recovery.`
}

export const ANALYZE_SCHEMA = {
  name: 'scene_analysis',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['canvas', 'background', 'elements', 'texts'],
    properties: {
      canvas: {
        type: 'object',
        additionalProperties: false,
        required: ['width', 'height'],
        properties: { width: { type: 'integer' }, height: { type: 'integer' } },
      },
      background: {
        type: 'object',
        additionalProperties: false,
        required: ['description', 'dominantColor'],
        properties: { description: { type: 'string' }, dominantColor: { type: 'string' } },
      },
      elements: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'label', 'box', 'z'],
          properties: {
            id: { type: 'string' },
            label: { type: 'string' },
            box: { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4 },
            z: { type: 'integer' },
          },
        },
      },
      texts: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'content', 'box', 'color', 'fontFamily', 'fontWeight', 'fontSize', 'align', 'italic', 'z'],
          properties: {
            id: { type: 'string' },
            content: { type: 'string' },
            box: { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4 },
            color: { type: 'string' },
            fontFamily: { type: 'string' },
            fontWeight: { type: 'integer' },
            fontSize: { type: 'number' },
            align: { type: 'string', enum: ['left', 'center', 'right'] },
            italic: { type: 'boolean' },
            z: { type: 'integer' },
          },
        },
      },
    },
  },
} as const

/**
 * Gemini's native grounding format: box_2d + base64 PNG mask.
 *
 * Deliberately one object per call. A mask arrives as base64 text in the completion
 * stream, so batching several into one response pushes the output into the tens of
 * thousands of tokens — measured at over 170s before timing out.
 */
export function segmentPrompt(label: string) {
  return `Give the segmentation mask for "${label}" in this image.

Output a JSON list containing exactly ONE entry, with:
- "label": "${label}"
- "box_2d": [y0, x0, y1, x1] normalised to 0..1000
- "mask": a base64-encoded PNG of the mask, where each pixel is the 0-255 probability that
  the pixel belongs to the object, in the coordinate space of that entry's own box_2d crop

Keep the mask compact. Output only the JSON list, nothing else.`
}

// -------------------------------------------------------------- erase

export function erasePrompt(targets: string[]) {
  const subjects = targets.length
    ? `the ${targets.map((t) => `"${t}"`).join(', ')}, and any written characters,`
    : 'any written characters'

  return `Restore this image to its empty background state.

Show the underlying surface exactly as it looked before ${subjects} were placed onto it —
bare, uninterrupted, and complete. Extend the existing textures, gradients, patterns, grain and
lighting continuously across the whole frame so the surface reads as one unbroken material.

No residue of anything that used to sit on the surface: no ghosting, no blur patches, no smudges,
no faint outlines, no partial fragments.

Everything else is unchanged: identical framing, identical composition, identical palette,
identical dimensions.`
}
