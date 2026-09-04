import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'

test('friend connection is independently routed after servers and keeps the existing functional component', () => {
  const app = fs.readFileSync('src/renderer/src/App.vue', 'utf8')
  const servers = fs.readFileSync('src/renderer/src/views/ServersView.vue', 'utf8')
  const friends = fs.readFileSync('src/renderer/src/views/FriendConnectView.vue', 'utf8')
  assert.match(app, /friends: FriendConnectView/)
  assert(app.indexOf("key: 'friends'") > app.indexOf("key: 'servers'"))
  assert(!servers.includes('FriendConnect'))
  assert.match(friends, /<FriendConnect\s*\/>/)
  assert.match(fs.readFileSync('src/renderer/src/views/SettingsView.vue', 'utf8'), /key: 'friends'/)
  for (const source of [app, servers, friends]) {
    const { descriptor, errors } = parse(source)
    assert.deepEqual(errors, [])
    const script = compileScript(descriptor, { id: 'test' })
    assert.deepEqual(compileTemplate({ source: descriptor.template!.content, filename: 'test.vue', id: 'test', compilerOptions: { bindingMetadata: script.bindings } }).errors, [])
  }
})
