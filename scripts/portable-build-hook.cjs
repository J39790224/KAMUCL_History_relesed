// electron-builder 26.15.3 的 portable 模板未引用可执行文件路径。
// TEMP / 用户名含空格时 ExecWait 失败（退出码1），主进程尚未运行。
// 在构建时变换模板，不修改 node_modules；升级模板后无法识别则阻止错误出包。
function repairPortableScript(script) {
  const old = 'ExecWait "$INSTDIR\\${APP_EXECUTABLE_FILENAME} $R0" $0'
  const fixed = `ExecWait '\"$INSTDIR\\\${APP_EXECUTABLE_FILENAME}\" $R0' $0`
  if (script.includes(fixed)) return script
  if (script.split(old).length !== 2) throw new Error('Portable NSIS template changed: review quoted launch command before release')
  return script.replace(old, `ClearErrors\n\t${fixed}\n\tIfErrors 0 +3\n\tMessageBox MB_OK|MB_ICONSTOP 'KAMUCL could not start. Please extract the Windows ZIP package and run KAMUCL.exe.'\n\tStrCpy $0 1`)
}

module.exports = function beforePack() {
  const { NsisTarget } = require('app-builder-lib/out/targets/nsis/NsisTarget')
  if (NsisTarget.prototype.__kamuclQuotedPortable) return
  const original = NsisTarget.prototype.computeFinalScript
  NsisTarget.prototype.computeFinalScript = function (script, ...args) {
    return original.call(this, this.isPortable ? repairPortableScript(script) : script, ...args)
  }
  NsisTarget.prototype.__kamuclQuotedPortable = true
}
module.exports.repairPortableScript = repairPortableScript
