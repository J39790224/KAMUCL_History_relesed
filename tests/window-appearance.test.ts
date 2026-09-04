import assert from 'node:assert/strict'
import test from 'node:test'
import { windowAppearance } from '../src/main/windowAppearance'

test('Windows 主窗口使用真正透明背景和 DWM Acrylic 材质', () => {
  const options = windowAppearance('win32')
  assert.equal(options.frame, false)
  assert.equal(options.transparent, true)
  assert.equal(options.backgroundColor, '#00000000')
  assert.equal(options.backgroundMaterial, 'acrylic')
  assert.equal(options.roundedCorners, true)
  assert.equal(options.thickFrame, true)
})

test('非 Windows 平台保留透明窗口但不请求 Windows 独占材质', () => {
  const options = windowAppearance('darwin')
  assert.equal(options.transparent, true)
  assert.equal(options.backgroundColor, '#00000000')
  assert.equal(options.backgroundMaterial, undefined)
})
