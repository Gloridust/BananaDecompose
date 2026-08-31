'use client'

// One global gate for every model call on the board.
//
// Concurrency used to be capped per branch, which meant branches had to run
// sequentially or they would multiply into a request storm. Gating globally
// instead lets every branch run at once while the total in-flight request count
// stays whatever the user picked — the scheduler, not the topology, decides load.

let limit = 4
let active = 0
const queue: (() => void)[] = []

export function setConcurrency(n: number) {
  limit = Math.min(12, Math.max(1, Math.round(n)))
  drain()
}

export function getConcurrency() {
  return limit
}

/** In-flight and waiting counts, for the live load indicator. */
export function load() {
  return { active, queued: queue.length, limit }
}

function drain() {
  while (active < limit && queue.length) {
    const next = queue.shift()!
    active++
    next()
  }
}

export async function schedule<T>(fn: () => Promise<T>): Promise<T> {
  await new Promise<void>((resolve) => {
    if (active < limit) {
      active++
      resolve()
    } else {
      queue.push(resolve)
    }
  })
  try {
    return await fn()
  } finally {
    active--
    drain()
  }
}
