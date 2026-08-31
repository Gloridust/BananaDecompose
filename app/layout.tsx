import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'BananaDecompose — 可编辑图层工作台',
  description:
    '用 Nano Banana 2 生成图像，并把它变成可编辑的图层与真实文字。两条管线：生成即分层 vs 事后拆解，可切换、可对比。',
}

// The fonts the planner is allowed to specify. Loaded up front so text layers
// render in the right face immediately — a swapped font moves every glyph.
const FONT_HREF =
  'https://fonts.googleapis.com/css2' +
  '?family=Inter:ital,wght@0,100..900;1,100..900' +
  '&family=Playfair+Display:ital,wght@0,400..900;1,400..900' +
  '&family=Space+Grotesk:wght@300..700' +
  '&family=Bebas+Neue' +
  '&family=Noto+Sans+SC:wght@100..900' +
  '&family=Noto+Serif+SC:wght@200..900' +
  '&display=swap'

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link rel="stylesheet" href={FONT_HREF} />
      </head>
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  )
}
