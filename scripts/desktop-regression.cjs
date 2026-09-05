// Real Electron UI with isolated writable settings/instances. No user account secrets.
// electron scripts/desktop-regression.cjs [--force-device-scale-factor=1.5]
// F8 prints read-only DOM geometry/state diagnostics. Native input drives the UI.
const { app, ipcMain, dialog } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const AdmZip = require('adm-zip')
const qaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kamucl-regression-069-'))
const previous = JSON.parse(fs.readFileSync(path.join(app.getPath('appData'), 'kamucl', 'settings.json'), 'utf8'))
app.setPath('userData', qaRoot)
const folder = path.join(qaRoot, 'games')
const versionRoot = path.join(folder, 'versions')
fs.mkdirSync(versionRoot, { recursive: true })
const longId = 'Fabulously-Optimized-自定义整合包-长名称缩放验证-v13.4.0'
for (const id of ['26.2', longId]) {
  const target = path.join(versionRoot, id)
  fs.mkdirSync(target)
  const sourceRoot = previous.folders.map(item => path.join(item.path, 'versions', '26.2')).find(p => fs.existsSync(path.join(p, '26.2.json')) && fs.existsSync(path.join(p, '26.2.jar')))
  if (!sourceRoot) throw new Error('Need an already installed vanilla 26.2 for offline runtime smoke test')
  const profile = JSON.parse(fs.readFileSync(path.join(sourceRoot, '26.2.json'), 'utf8'))
  fs.writeFileSync(path.join(target, `${id}.json`), JSON.stringify({ ...profile, id, _mcVersion: '26.2', _gameDir: true }))
  fs.copyFileSync(path.join(sourceRoot, '26.2.jar'), path.join(target, `${id}.jar`))
}
const defaultFolder = previous.folders.find(item => item.isDefault)
fs.writeFileSync(path.join(qaRoot, 'settings.json'), JSON.stringify({
  theme: 'transparent', folders: [defaultFolder, { path: folder, name: '隔离验收目录', isDefault: false }],
  gameDir: folder, activeFolder: folder, javaAuto: true, memoryMB: 4096, lastVersion: '26.2',
  resolution: { width: 854, height: 480, mode: 'windowed', fullscreen: false }, closeAfterLaunch: false
}))
const account = { id: 'qa-offline', type: 'offline', username: 'KamuclQA', uuid: '00000000000000000000000000000001', accessToken: 'offline-test' }
fs.writeFileSync(path.join(qaRoot, 'accounts.json'), JSON.stringify({ accounts: [account], selectedId: account.id }))
const zip = new AdmZip()
zip.addFile('modrinth.index.json', Buffer.from(JSON.stringify({ formatVersion: 1, game: 'minecraft', name: '26.2', versionId: 'QA', dependencies: { minecraft: '26.2' }, files: [] })))
const pack = path.join(qaRoot, '26.2.mrpack')
zip.writeZip(pack)
const handle = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (channel, listener) => handle(channel, (...args) => {
  if (channel === 'app:selectFile') return pack
  return listener(...args)
})
// Only replaces the OS chooser in the QA harness; the real image processor/settings/renderer run unchanged.
const choose = dialog.showOpenDialog.bind(dialog)
dialog.showOpenDialog = async (...args) => {
  const options = args[args.length - 1]
  if (options.title?.includes('轮播图片')) {
    const dir = path.resolve('src/renderer/src/assets')
    const images = fs.readdirSync(dir).filter(s => /banner.*\.(png|jpg|jpeg|webp)$/i.test(s)).slice(0, 2).map(s => path.join(dir, s))
    if (images.length !== 2) throw new Error('QA requires two existing banner assets')
    return { canceled: false, filePaths: images }
  }
  return choose(...args)
}
console.log('QA_ROOT=' + qaRoot)
app.on('browser-window-created', (_event, window) => {
  if (window.getTitle().includes('正在启动')) return
  if (process.argv.includes('--qa-small')) window.setSize(960, 620)
  window.on('show', () => {
    window.setTitle('KAMUCL 0.6.9 · 回归验收')
    window.webContents.executeJavaScript(`JSON.stringify({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,overflow:document.documentElement.scrollWidth>innerWidth,hero:document.querySelector('.hero')?.getBoundingClientRect().toJSON(),instances:[...document.querySelectorAll('.instance-copy strong')].map(e=>({text:e.textContent,width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height}))})`).then(value=>console.log('QA_LAYOUT='+value))
  })
  window.webContents.on('before-input-event', (_event, input) => {
    if (input.key === 'F8' && input.type === 'keyDown') {
      window.webContents.executeJavaScript(`JSON.stringify({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,overflow:document.documentElement.scrollWidth>innerWidth,rows:[...document.querySelectorAll('.installed-row')].map(e=>({text:e.innerText,width:e.clientWidth,height:e.clientHeight})),images:[...document.querySelectorAll('.hero-bg')].map(e=>e.getAttribute('style')),switches:[...document.querySelectorAll('.switch input')].map(e=>({checked:e.checked,width:e.getBoundingClientRect().width})),modal:!!document.querySelector('.modpack-import-modal'),drag:!!document.querySelector('.drop-mask')})`).then(value => console.log('QA_STATE=' + value))
    }
  })
})
require('../out/main/index.js')
