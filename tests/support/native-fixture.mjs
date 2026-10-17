// Real Linux operations for the native-file tests, also used by the Windows A/B.
import { spawn } from 'node:child_process'
import { Context } from '@deepseek-ai/cordis'
import { joinUnc } from '../../src/shared/paths.ts'
import { load } from '../../scripts/compatibility/plane.mjs'
export const { WslFileSystem } = await load('fs')
export const windows = process.platform === 'win32'
export const distro = process.env.WSL_COMPAT_DISTRO || 'Ubuntu'
export const linuxLaunch = (_target, code) => spawn('python3', ['-I', '-S', '-u', '-c', code], { stdio: 'pipe' })
export const rpcOptions = windows ? {} : { launch: linuxLaunch }
export function startPython(script, args = [], options = {}) {
  const values = ['-I', '-S', '-u', '-c', script, ...args]
  return windows
    ? spawn('wsl.exe', ['-d', distro, '--cd', '/', '-e', 'python3', ...values], { stdio: 'pipe', windowsHide: true, ...options })
    : spawn('python3', values, { stdio: 'pipe', ...options })
}
export function python(script, args = [], input = '', options = {}) {
  return new Promise((resolve, reject) => {
    const child = startPython(script, args, options)
    const out = [], err = []
    const timer = setTimeout(() => { child.kill(); reject(new Error('fixture Python timed out')) }, 30_000)
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.stdout.on('data', b => out.push(b)); child.stderr.on('data', b => err.push(b))
    child.stdin.on('error', () => {})
    child.on('close', code => {
      clearTimeout(timer)
      if (code !== 0) reject(new Error(`fixture rc=${code}: ${Buffer.concat(err)}`))
      else resolve(Buffer.concat(out))
    })
    child.stdin.end(input)
  })
}
export const writeRaw = (file, bytes) => python('import os,sys;os.makedirs(os.path.dirname(sys.argv[1]),exist_ok=True);open(sys.argv[1],"wb").write(sys.stdin.buffer.read())', [file], bytes)
export const readRaw = file => python('import sys;sys.stdout.buffer.write(open(sys.argv[1],"rb").read())', [file])
export const removeRaw = file => python('import os,sys;os.unlink(sys.argv[1])', [file])
export const pyJson = async (script, args = [], input = '') => JSON.parse((await python(script, args, input)).toString('utf8'))
export async function makeFixture(options = {}) {
  // Outside /tmp: workspace-write intentionally permits Linux /tmp.
  const root = (await python('import os,tempfile;print(tempfile.mkdtemp(prefix=".dsh-native-",dir=os.path.expanduser("~")))')).toString().trim()
  const cwd = joinUnc(distro, root)
  const owners = []
  const provider = (extra = {}) => {
    const context = new Context()
    const fs = new WslFileSystem(context, { cwd, backend: 'native', diffBasisMaxBytes: 1024 * 1024, ...options, ...extra }, rpcOptions)
    owners.push({ context, fs })
    return fs
  }
  const fs = provider()
  return { root, cwd, fs, provider,
    async cleanup() {
      for (const owner of owners) owner.fs.wslRpcPool?.dispose()
      await python('import shutil,sys;shutil.rmtree(sys.argv[1])', [root])
    },
  }
}
export async function collect(stream) { let out = ''; for await (const value of stream) out += value; return out }
export const codeIs = code => error => error?.code === code
export async function lockedDirectory(directory) {
  const child = startPython('import os,fcntl,sys;fd=os.open(sys.argv[1],os.O_RDONLY|os.O_DIRECTORY);fcntl.flock(fd,fcntl.LOCK_EX);print("locked",flush=True);sys.stdin.read();os.close(fd)', [directory])
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('lock fixture did not start')) }, 10_000)
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.stdout.once('data', () => { clearTimeout(timer); resolve() })
    child.once('exit', code => { if (code !== 0) { clearTimeout(timer); reject(new Error(`lock fixture rc=${code}`)) } })
  })
  return async () => {
    if (child.exitCode !== null) return
    const closed = new Promise(resolve => child.once('close', resolve))
    child.stdin.end(); await closed
  }
}
