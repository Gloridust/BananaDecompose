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

// ------------------------------------------------------- refine a run

export function refinePrompt(hint: string) {
  return `This crop contains a single run of text, enlarged.

${hint ? `A rough first read said it was: "${hint}". Correct it if that is wrong.\n\n` : ''}Report:
- "content": the text EXACTLY as written — same characters, same case, same punctuation,
  same language, same spacing. Nothing added, nothing translated, nothing normalised.
- "fontFamily": the closest match among Inter, Georgia, Playfair Display, Space Grotesk,
  Bebas Neue, Noto Sans SC, Noto Serif SC, system-ui. Judge by the letterforms —
  serif vs sans, stroke contrast, terminal shapes, width. For Chinese, choose between
  Noto Sans SC (no serifs) and Noto Serif SC (serifs / 宋体-like strokes).
- "fontWeight": 100..900 in hundreds, judged by stroke thickness relative to height.
- "italic": true only if the glyphs are genuinely slanted.
- "isText": false if this crop turns out to hold no readable text at all.

Do not report any coordinates or sizes — those are measured elsewhere.`
}

export const REFINE_SCHEMA = {
  name: 'refined_run',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['content', 'fontFamily', 'fontWeight', 'italic', 'isText'],
    properties: {
      content: { type: 'string' },
      fontFamily: { type: 'string' },
      fontWeight: { type: 'integer' },
      italic: { type: 'boolean' },
      isText: { type: 'boolean' },
    },
  },
} as const

// --------------------------------------------------------- region edit

/**
 * Redraw one region of a composition in place.
 *
 * The reference is the region itself with a margin of its surroundings, so the
 * model can match the lighting, palette and rendering style of what it is being
 * dropped back into — an edit that ignores its neighbourhood reads as a sticker.
 */
export function editRegionPrompt(instruction: string) {
  return `Apply this change to the image: ${instruction}

Keep the exact same framing, camera angle, scale and composition as the reference.
Everything the instruction does not mention stays as it is — same lighting direction, same
colour palette, same rendering style, same level of detail, same texture and grain.
The edges of the frame must continue to match their surroundings seamlessly, because this
crop is going straight back into the picture it came from.

Return the full frame, edge to edge. Do not add borders, captions, labels or annotations.`
}

// ------------------------------------------------------------- retype

/**
 * Redraw one run of type with different words but the same lettering.
 *
 * The reference image is a crop of the original run, so the model has the actual
 * letterforms to copy rather than a description of them — which is the only way
 * to keep hand-drawn or AI-invented type looking like itself after an edit.
 */
export function retypePrompt(text: string, backdrop: 'white' | 'black') {
  const ground =
    backdrop === 'white'
      ? 'completely flat, uniform PURE WHITE (#FFFFFF)'
      : 'completely flat, uniform PURE BLACK (#000000)'

  return `Write exactly this text, and nothing else: ${text}

Copy the lettering in the reference image precisely — the same typeface, the same stroke weights
and stroke endings, the same proportions, the same slant, the same spacing rhythm, the same colour,
the same texture and any wear or shading on the strokes. Someone who knows the original should read
the result as the same hand, just different words.

Set it on one line, horizontally, filling the frame with a small even margin.
Place it on a ${ground} background that fills the entire frame edge to edge — perfectly uniform,
no gradient, no vignette, no texture, no shadow, no glow, no outline, no box, no decoration.
Nothing in the frame except the lettering itself.`
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
no faint outlines, no partial fragments. Fading something down until it blends in is not removal —
the surface must be genuinely empty, as if nothing was ever placed there.

Everything else is unchanged: identical framing, identical composition, identical palette,
identical dimensions. Match the exact shade and brightness of the surrounding surface.`
}

/**
 * Clear one small patch rather than the whole frame.
 *
 * Handing the model the entire poster and asking it to remove the type gives it
 * enough latitude to re-tone everything — observed: a header band came back
 * several shades darker and the title merely faded rather than gone. A crop that
 * is mostly surface already leaves far less room for interpretation, and the
 * patch is composited back so nothing outside it can drift at all.
 */
export function erasePatchPrompt() {
  return `Return this exact crop with the surface empty.

Whatever is sitting on top of the surface — lettering, characters, marks, objects — is gone, and
the material underneath continues through where it used to be: same colour, same brightness, same
texture, same grain, same weave, same gradient direction, same wear.

Fading something until it blends in does not count. Nothing may remain of it, not a faint outline,
not a soft patch, not a change in tone where it used to be.

Do not adjust the overall colour, brightness or contrast of the crop — it is being placed straight
back into a larger picture and must match its surroundings exactly. Keep the identical framing and
dimensions. Add nothing.`
}
