/**
 * dsh-titlebar-restart — host half.
 *
 * Publishes exactly one authenticated route, `POST /api/titlebar-restart`, on the
 * Connection channel. A POST writes a small PowerShell script and asks WMI to run
 * it, so the helper is parented by WmiPrvSE rather than by this process: it
 * survives the Electron tree it is about to stop, waits for the listening port to
 * be released, and starts the Desktop application again — the same effect as the
 * application menu's `app.relaunch()`.
 *
 * The route rides `ctx.connection.fetch`, so the Connection plugin applies its
 * Host/Origin fence and the browser-session cookie before the handler runs: an
 * unauthenticated caller gets 401/403 and never reaches the spawn.
 *
 * Windows + DSH Desktop only. Under `dsh web` the parent has no IPC channel, so
 * the route answers 409 `not-desktop` and touches nothing.
 */

import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const name = 'dsh-titlebar-restart'
export const inject = ['connection']

/** Exact pathname served through the Connection `/api` channel. */
const ROUTE_PATH = '/api/titlebar-restart'

/** Working directory for the generated scripts and their log. */
const WORK_DIR = join(tmpdir(), 'dsh-titlebar-restart')
const LOG_PATH = join(WORK_DIR, 'restart.log')
const SCRIPT_PATH = join(WORK_DIR, 'restart.ps1')
const LAUNCHER_PATH = join(WORK_DIR, 'launch.ps1')

function log (line) {
  try {
    mkdirSync(WORK_DIR, { recursive: true })
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${line}\n`)
  } catch {
    /* logging must never break the restart */
  }
}

function json (status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/**
 * Whether this Host process is the child of the Electron Desktop shell.
 *
 * The Desktop shell spawns its Host with an IPC channel; a `dsh web` run started
 * from a terminal has none, and killing its parent would kill the terminal.
 *
 * @returns true only for the Windows Desktop carrier.
 */
function isDesktopShell () {
  if (process.platform !== 'win32') return false
  if (typeof process.versions.electron !== 'string') return false
  return typeof process.send === 'function' && process.connected === true
}

/** Quote one PowerShell single-quoted literal. */
function psQuote (value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

/**
 * The script WMI runs: wait one beat so the HTTP response reaches the browser,
 * stop the Electron main process and this Host, wait for the listen port to be
 * released, then start the executable again.
 *
 * @param mainPid - Electron main process id (this Host's parent).
 * @param hostPid - this process id.
 * @param executable - Electron executable to start again.
 * @param port - listening port to wait on, or 0 to skip the wait.
 * @returns PowerShell source.
 */
function buildScript (mainPid, hostPid, executable, port) {
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$exe = ${psQuote(executable)}`,
    `$log = ${psQuote(LOG_PATH)}`,
    'function Note($m) { Add-Content -LiteralPath $log -Value ((Get-Date).ToString(\'o\') + \' \' + $m) -ErrorAction SilentlyContinue }',
    "if (-not (Test-Path -LiteralPath $exe)) { Note 'abort: executable missing'; exit 1 }",
    "Note 'helper start'",
    'Start-Sleep -Milliseconds 900',
    `Stop-Process -Id ${mainPid} -Force -ErrorAction SilentlyContinue`,
    'Start-Sleep -Milliseconds 800',
    `Stop-Process -Id ${hostPid} -Force -ErrorAction SilentlyContinue`,
    'Start-Sleep -Milliseconds 900',
    ...(port > 0
      ? [
          'for ($i = 0; $i -lt 20; $i++) {',
          `  if (-not (Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue)) { break }`,
          '  Start-Sleep -Milliseconds 250',
          '}',
        ]
      : []),
    'for ($i = 0; $i -lt 3; $i++) {',
    "  try { Start-Process -FilePath $exe -WorkingDirectory (Split-Path -LiteralPath $exe); Note 'relaunched'; break }",
    "  catch { Note ('start failed: ' + $_.Exception.Message); Start-Sleep -Milliseconds 1200 }",
    '}',
    '',
  ].join('\r\n')
}

/**
 * Write the helper and hand it to WMI.
 *
 * The launcher itself is disposable — it only issues `Win32_Process.Create` and
 * exits, so it is spawned without `detached`: a detached child is not reliable
 * under every confinement layer, and it does not need to outlive anything.
 *
 * @param port - the listening port to wait for, or 0.
 */
function relaunch (port) {
  mkdirSync(WORK_DIR, { recursive: true })
  const executable = process.execPath
  writeFileSync(SCRIPT_PATH, buildScript(process.ppid, process.pid, executable, port), 'utf8')

  const command = `powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${SCRIPT_PATH}"`
  writeFileSync(
    LAUNCHER_PATH,
    [
      `$command = ${psQuote(command)}`,
      '$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $command }',
      `Add-Content -LiteralPath ${psQuote(LOG_PATH)} -Value ((Get-Date).ToString('o') + ' wmi create returned ' + [string]$result.ReturnValue) -ErrorAction SilentlyContinue`,
      '',
    ].join('\r\n'),
    'utf8',
  )

  log(`restart requested (main=${process.ppid} host=${process.pid} port=${port} exe=${executable})`)
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', LAUNCHER_PATH],
    { stdio: 'ignore', windowsHide: true },
  )
  child.on('error', (error) => log(`spawn failed: ${String(error?.message ?? error)}`))
  child.unref()
  log('helper dispatched via WMI')
}

export function apply (ctx) {
  let requested = false
  log(`mounted (pid=${process.pid} ppid=${process.ppid} desktop=${String(isDesktopShell())})`)

  try {
    ctx.connection.fetch.register({
      path: ROUTE_PATH,
      methods: ['POST'],
      fetch: async () => {
        log('restart request received')
        if (!isDesktopShell()) return json(409, { ok: false, reason: 'not-desktop' })
        if (requested) return json(202, { ok: true, restarting: true })
        requested = true
        const port = Number(ctx.get('webServer')?.port ?? 0) || 0
        setTimeout(() => {
          try {
            relaunch(port)
          } catch (error) {
            requested = false
            log(`relaunch threw: ${String(error?.stack ?? error)}`)
          }
        }, 150)
        return json(200, { ok: true, restarting: true })
      },
    })
    log(`route registered: ${ROUTE_PATH}`)
  } catch (error) {
    log(`route registration failed: ${String(error?.stack ?? error)}`)
    throw error
  }
}
