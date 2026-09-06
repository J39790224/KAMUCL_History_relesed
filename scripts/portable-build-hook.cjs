// electron-builder 26.15.3 的 portable 模板有两个问题需要构建时修复：
// 1. 未引用可执行文件路径——TEMP / 用户名含空格时 ExecWait 失败（退出码1），主进程尚未运行。
// 2. 解压目录：模板优先走 "$TEMP\${UNPACK_DIR_NAME}"（unpackDirName 即使为 false 也会
//    被 electron-builder 填成随机 ksuid），否则才落 $PLUGINSDIR\app——两条路径都在系统 TEMP，
//    用户不可见且占用系统盘；统一改为解压到 exe 所在目录的固定子目录 KAMUCL-runtime
//    （启动前清理解压，退出后删除）。
// 在构建时变换模板，不修改 node_modules；升级模板后无法识别则阻止错误出包。
const OLD_UNPACK_PLUGINS = 'StrCpy $INSTDIR "$PLUGINSDIR\\app"'
const OLD_UNPACK_TEMP = 'StrCpy $INSTDIR "$TEMP\\${UNPACK_DIR_NAME}"'
const NEW_UNPACK = 'StrCpy $INSTDIR "$EXEDIR\\KAMUCL-runtime"'

function repairPortableScript(script) {
  // 解压目录：TEMP 两条分支（ksuid 随机目录 / plugins 临时目录）→ exe 所在文件夹的固定子目录
  if (!script.includes(NEW_UNPACK)) {
    if (script.split(OLD_UNPACK_TEMP).length !== 2) throw new Error('Portable NSIS template changed: review unpack directory before release')
    script = script.replace(OLD_UNPACK_TEMP, NEW_UNPACK)
    // PLUGINSDIR\app 分支仅在 UNPACK_DIR_NAME 未定义时生效；一并替换保持语义一致
    if (script.includes(OLD_UNPACK_PLUGINS)) script = script.replace(OLD_UNPACK_PLUGINS, NEW_UNPACK)
  }
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
