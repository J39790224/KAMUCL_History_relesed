import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once, EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { GameSession } from '../src/main/core/gameSession'

test('launch reservation blocks double clicks during preparation and ignores stale exits', () => {
  const session = new GameSession()
  const first = session.reserve('A')
  assert.throws(() => session.reserve('B'), /已有游戏/)
  assert(session.release(first))
  const second = session.reserve('B')
  assert(!session.release(first))
  assert.equal(session.versionId, 'B')
  session.release(second)
})
test('rejected termination leaves the game owned and clears temporary listeners', async () => {
  const session = new GameSession()
  const token = session.reserve('alive')
  const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, kill: () => false })
  session.attach(token, child as unknown as ChildProcess)
  await assert.rejects(session.stop(), /未接受/)
  assert(session.busy)
  assert.equal(child.listenerCount('exit'), 0)
  assert.equal(child.listenerCount('error'), 0)
})
test('stop waits for the owned real process to exit and never announces success for missing process', async () => {
  const session = new GameSession()
  await assert.rejects(session.stop(), /没有/)
  const token = session.reserve('fixture')
  await assert.rejects(session.stop(), /准备/)
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: 'ignore' })
  session.attach(token, child)
  const closed = once(child, 'close')
  child.once('close', () => session.release(token))
  await once(child, 'spawn')
  try { await session.stop(); await closed; assert(!session.busy) }
  finally { if (child.exitCode === null && child.signalCode === null) child.kill() }
})
