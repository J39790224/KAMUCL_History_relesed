import assert from 'node:assert/strict'
import test from 'node:test'
import {
  expandWindowsEnvironment,
  normalizeJavaArchitecture,
  parseJavaProbeOutput,
  parseRegistryJavaHomes,
  shouldPruneJavaDirectory
} from '../src/main/core/javaScanUtils'

test('Java 探测输出解析版本、架构和发行版', () => {
  const modern = parseJavaProbeOutput(`
Property settings:
    java.vendor = Eclipse Adoptium
    java.version = 21.0.5
    os.arch = amd64
openjdk version "21.0.5" 2024-10-15 LTS
`, 'win32')
  assert.deepEqual(modern, {
    major: 21,
    version: '21.0.5',
    is64Bit: true,
    architecture: 'x64',
    vendor: 'Eclipse Adoptium'
  })

  const legacy = parseJavaProbeOutput(
    'java version "1.8.0_431"\nJava HotSpot(TM) Client VM (build 25.431-b10, mixed mode)',
    'win32'
  )
  assert.equal(legacy?.major, 8)
  assert.equal(legacy?.architecture, 'x86')
  assert.equal(legacy?.is64Bit, false)
})

test('Java 架构别名归一化', () => {
  assert.equal(normalizeJavaArchitecture('amd64'), 'x64')
  assert.equal(normalizeJavaArchitecture('x86_64'), 'x64')
  assert.equal(normalizeJavaArchitecture('aarch64'), 'arm64')
  assert.equal(normalizeJavaArchitecture('i386'), 'x86')
})

test('注册表 JavaHome/Path 解析并展开环境变量、忽略无关值', () => {
  const output = `
HKEY_LOCAL_MACHINE\\SOFTWARE\\JavaSoft\\JDK\\17
    JavaHome    REG_SZ    D:\\Java\\jdk-17
    RuntimeLib    REG_SZ    D:\\Java\\jdk-17\\bin\\server\\jvm.dll
HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\JDK\\21
    Path    REG_EXPAND_SZ    %ProgramFiles%\\Microsoft\\jdk-21
    Feature    REG_DWORD    0x1
`
  assert.deepEqual(parseRegistryJavaHomes(output, { ProgramFiles: 'C:\\Program Files' }), [
    'D:\\Java\\jdk-17',
    'C:\\Program Files\\Microsoft\\jdk-21'
  ])
  assert.equal(
    expandWindowsEnvironment('%JAVA_ROOT%\\bin', { JAVA_ROOT: 'E:\\Runtimes\\Java' }),
    'E:\\Runtimes\\Java\\bin'
  )
})

test('全盘扫描目录剪枝不会进入系统、依赖和游戏内容目录', () => {
  for (const name of [
    '$Recycle.Bin',
    'System Volume Information',
    'Windows',
    'node_modules',
    '.git',
    'libraries',
    'assets',
    'versions',
    'mods',
    'saves'
  ]) {
    assert.equal(shouldPruneJavaDirectory(name), true, name)
  }
  for (const name of ['jdk-21', 'runtime', 'jre', 'bin', 'Contents']) {
    assert.equal(shouldPruneJavaDirectory(name), false, name)
  }
})
