import assert from 'node:assert/strict'
import test from 'node:test'
import { StartupGate, makeBootPixels, pixelPosition, RISE_END, CONVERGE_DURATION } from '../src/shared/startup'
import { beginBootTask, waitForBootTasks } from '../src/renderer/src/bootTasks'

test('startup reveal requires actual renderer initialization, a painted frame and assembled avatar in any arrival order', () => {
  const gate = new StartupGate()
  gate.assembled = true
  assert(!gate.canReveal)
  gate.painted = true
  assert(!gate.canReveal)
  gate.rendererReady = true
  assert(gate.canReveal)
  const slow = new StartupGate()
  slow.rendererReady = true
  assert(!slow.state.ready)
  slow.painted = true
  assert(slow.state.ready)
  assert(!slow.canReveal)
  slow.assembled = true
  assert(slow.canReveal)
})

test('64 source pixels rise on desktop, wait for real readiness and assemble exactly at multiple display sizes', () => {
  for (const [width, height] of [[1280, 720], [1707, 960], [2560, 1440], [3840, 2160]]) {
    const { pixels, size } = makeBootPixels(width, height, () => .5)
    assert.equal(pixels.length, 64)
    assert.equal(new Set(pixels.map(p => `${p.targetX},${p.targetY}`)).size, 64)
    for (const p of pixels) {
      const initial = pixelPosition(p, 0, null)
      const floating = pixelPosition(p, RISE_END, null)
      assert(floating.y < initial.y)
      assert(Math.abs(floating.x - initial.x) <= 3)
      const slow = pixelPosition(p, 60000, null)
      assert(Math.abs(slow.x - p.x) <= 3)
      for (const elapsed of [RISE_END, RISE_END + 100, RISE_END + 600]) {
        const position = pixelPosition(p, elapsed, RISE_END)
        assert(Object.values(position).every(Number.isFinite))
      }
      assert.deepEqual(pixelPosition(p, RISE_END + CONVERGE_DURATION, RISE_END), { x: p.targetX, y: p.targetY, rotation: 0 })
      assert(p.targetX >= 0 && p.targetX + size <= width)
      assert(p.targetY >= 0 && p.targetY + size <= height)
    }
  }
})

test('startup resource barrier also drains resources registered during an earlier async load', async () => {
  const first = beginBootTask()
  let settled = false
  const wait = waitForBootTasks().then(() => { settled = true })
  const second = beginBootTask()
  first()
  await Promise.resolve()
  assert(!settled)
  second()
  await wait
  assert(settled)
  second() // completion is idempotent
})
