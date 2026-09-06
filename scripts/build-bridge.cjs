// 编译并打包桥接 MOD（javac --release 17，零 Gradle 依赖）。
// 用法: node scripts/build-bridge.cjs
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')
const bridgeDir = path.join(root, 'bridge')
const outClasses = path.join(bridgeDir, 'build', 'classes')
const outJar = path.join(bridgeDir, 'dist', 'kamucl-bridge-1.0.0.jar')

const javaHome = process.env.JAVA_HOME || 'C:\\Program Files\\Java\\jdk-25.0.2'
const javac = path.join(javaHome, 'bin', 'javac.exe')
const jar = path.join(javaHome, 'bin', 'jar.exe')
if (!fs.existsSync(javac)) throw new Error(`javac not found: ${javac}（设置 JAVA_HOME 指向 JDK）`)

const libs = path.join(process.env.APPDATA || '', '.kamucl', 'libraries')
const cp = [
  path.join(libs, 'net', 'fabricmc', 'fabric-loader', '0.19.5', 'fabric-loader-0.19.5.jar'),
  path.join(libs, 'com', 'google', 'code', 'gson', 'gson', '2.14.0', 'gson-2.14.0.jar')
]
for (const jarPath of cp) if (!fs.existsSync(jarPath)) throw new Error(`classpath jar missing: ${jarPath}`)

fs.rmSync(outClasses, { recursive: true, force: true })
fs.mkdirSync(outClasses, { recursive: true })
fs.mkdirSync(path.dirname(outJar), { recursive: true })

const sources = []
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(p)
    else if (entry.name.endsWith('.java')) sources.push(p)
  }
}
walk(path.join(bridgeDir, 'src', 'cn'))

execFileSync(javac, ['-encoding', 'UTF-8', '--release', '17', '-cp', cp.join(';'), '-d', outClasses, ...sources], { stdio: 'inherit' })

// fabric.mod.json 进 jar 根目录
fs.copyFileSync(path.join(bridgeDir, 'src', 'fabric.mod.json'), path.join(outClasses, 'fabric.mod.json'))

fs.rmSync(outJar, { force: true })
execFileSync(jar, ['cf', outJar, '-C', outClasses, '.'], { stdio: 'inherit' })
console.log('built: ' + outJar + ' (' + fs.statSync(outJar).size + ' bytes)')
