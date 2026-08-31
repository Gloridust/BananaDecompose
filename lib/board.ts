'use client'

import type { Board, BoardNode, NodeKind } from './types'

// A layered DAG layout. Columns are pipeline depth, rows are branch lanes, and a
// node feeding several branches is centred across the lanes it feeds — so a shared
// plan visibly fans out into every matting chain that depends on it.

export const COL_GAP = 92
export const ROW_GAP = 26
export const NODE_W = 208

export const NODE_H: Record<NodeKind, number> = {
  prompt: 116,
  plan: 168,
  plate: 194,
  source: 194,
  analysis: 168,
  renders: 176,
  cuts: 176,
  text: 176,
  erase: 194,
  scene: 250,
}

export const KIND_LABEL: Record<NodeKind, string> = {
  prompt: '提示词',
  plan: '规划',
  plate: '背景板',
  source: '来源图',
  analysis: '读版面',
  renders: '渲染',
  cuts: '抠图',
  text: '字形贴合',
  erase: '重绘',
  scene: '成品场景',
}

/** Accent per kind, so a column reads as a stage at a glance. */
export const KIND_COLOR: Record<NodeKind, string> = {
  prompt: '#7a7a8c',
  plan: '#8b7cf6',
  plate: '#38bdf8',
  source: '#38bdf8',
  analysis: '#8b7cf6',
  renders: '#f5b91c',
  cuts: '#34d399',
  text: '#22d3ee',
  erase: '#fb7185',
  scene: '#ffd24a',
}

export type Placed = { node: BoardNode; x: number; y: number; w: number; h: number }
export type Layout = {
  placed: Placed[]
  byId: Map<string, Placed>
  width: number
  height: number
}

function depths(nodes: BoardNode[]): Map<string, number> {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const depth = new Map<string, number>()

  const walk = (id: string, seen: Set<string>): number => {
    const cached = depth.get(id)
    if (cached !== undefined) return cached
    if (seen.has(id)) return 0 // cycles cannot happen by construction, but never hang
    seen.add(id)
    const node = byId.get(id)
    const inputs = (node?.inputs ?? []).filter((i) => byId.has(i))
    const d = inputs.length ? Math.max(...inputs.map((i) => walk(i, seen))) + 1 : 0
    depth.set(id, d)
    return d
  }

  for (const n of nodes) walk(n.id, new Set())
  return depth
}

export function layout(nodes: BoardNode[], branchOrder: string[]): Layout {
  if (!nodes.length) return { placed: [], byId: new Map(), width: 0, height: 0 }

  const depth = depths(nodes)
  const laneOf = (n: BoardNode) => {
    const idx = n.branches.map((b) => branchOrder.indexOf(b)).filter((i) => i >= 0)
    if (!idx.length) return 0
    return idx.reduce((a, b) => a + b, 0) / idx.length
  }

  const columns = new Map<number, BoardNode[]>()
  for (const n of nodes) {
    const d = depth.get(n.id) ?? 0
    const list = columns.get(d) ?? []
    list.push(n)
    columns.set(d, list)
  }

  const placed: Placed[] = []
  const colKeys = [...columns.keys()].sort((a, b) => a - b)
  let x = 0

  for (const d of colKeys) {
    const list = columns.get(d)!.sort((a, b) => laneOf(a) - laneOf(b) || a.id.localeCompare(b.id))
    // Seed each node at its lane's ideal y, then push down to clear overlaps.
    let cursor = -Infinity
    for (const node of list) {
      const h = NODE_H[node.kind]
      const ideal = laneOf(node) * (NODE_H.scene + ROW_GAP)
      const y = Math.max(ideal, cursor)
      placed.push({ node, x, y, w: NODE_W, h })
      cursor = y + h + ROW_GAP
    }
    x += NODE_W + COL_GAP
  }

  const byId = new Map(placed.map((p) => [p.node.id, p]))
  const width = placed.reduce((m, p) => Math.max(m, p.x + p.w), 0)
  const height = placed.reduce((m, p) => Math.max(m, p.y + p.h), 0)
  return { placed, byId, width, height }
}

/** Cubic bezier from one card's right edge to another's left edge. */
export function edgePath(from: Placed, to: Placed) {
  const x1 = from.x + from.w
  const y1 = from.y + from.h / 2
  const x2 = to.x
  const y2 = to.y + to.h / 2
  const dx = Math.max(36, (x2 - x1) * 0.5)
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`
}

/** Nodes still worth drawing once branches and individual nodes are switched off. */
export function visibleNodes(board: Board, hiddenBranches: Set<string>, hiddenNodes: Set<string>) {
  return board.nodes.filter((n) => {
    if (hiddenNodes.has(n.id)) return false
    if (!n.branches.length) return true
    // A shared node stays as long as one branch it feeds is still on.
    return n.branches.some((b) => !hiddenBranches.has(b))
  })
}
