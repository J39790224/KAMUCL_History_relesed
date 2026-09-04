import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import { acceptsImportDrag, showsImportOverlay } from '../src/shared/dropIntent'

test('internal text drag never imports; external files and provider URLs still work', () => {
  for (const types of [['text/plain'], ['text/uri-list'], ['Files']]) {
    assert(!acceptsImportDrag(types, true))
    assert(!showsImportOverlay(types, true))
    assert(acceptsImportDrag(types, false))
  }
  assert(!showsImportOverlay(['text/plain'], false))
  assert(showsImportOverlay(['Files'], false))
  assert(!acceptsImportDrag([], false))
})
test('favorites render once with full controls; list and switch targets cannot collapse', () => {
  const game = fs.readFileSync('src/renderer/src/views/GameView.vue', 'utf8')
  assert(!game.includes('v-for="v in favoriteInstalled"'))
  assert(game.includes('v-for="v in sortedInstalled"'))
  assert.match(game, /flex: 1 1 200px/)
  const css = fs.readFileSync('src/renderer/src/styles.css', 'utf8')
  assert.match(css, /\.switch input\s*\{[^}]*width: 100%/)
  assert.match(css, /\.switch-ui\s*\{[^}]*pointer-events: none/)
})
test('modpack text selection cannot dismiss on mouse release; conflict cards are full sized', () => {
  const app = fs.readFileSync('src/renderer/src/App.vue', 'utf8')
  assert.match(app, /@pointerdown.self="closeModpackImport"/)
  assert(!app.includes('@click.self="closeModpackImport"'))
  assert.match(app, /min-height: 48px/)
  for (const file of ['App.vue', 'views/GameView.vue', 'views/SettingsView.vue']) {
    const source = fs.readFileSync('src/renderer/src/' + file, 'utf8')
    const { descriptor, errors } = parse(source)
    assert.deepEqual(errors, [])
    const script = compileScript(descriptor, { id: file })
    assert.deepEqual(compileTemplate({ source: descriptor.template!.content, filename: file, id: file, compilerOptions: { bindingMetadata: script.bindings } }).errors, [])
  }
})
