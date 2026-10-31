/**
 * The local `git` executable: non-interactive runs with a bounded timeout,
 * and access tokens handed to one git process through a host-scoped
 * credential helper that reads them from that process's environment, so a
 * token never appears in argv, `.git/config`, or git output.
 *
 * @module dsh-repo/mirror/git
 */

import { spawn } from 'node:child_process'

/** A failed git command with its trimmed output. */
export class GitError extends Error {
  /**
   * @param args - git arguments that failed.
   * @param output - trimmed stderr (or stdout when stderr is empty).
   */
  constructor(readonly args: readonly string[], readonly output: string) {
    super(`git ${args.join(' ')} 失败：${output === '' ? '无输出' : output}`)
  }
}

/** Options of one git command. */
export interface GitRunOptions {
  readonly cwd?: string
  readonly timeoutMs: number
  /** Variables added to the environment of this command only. */
  readonly env?: Readonly<Record<string, string>>
  readonly signal?: AbortSignal
  /**
   * Keep only the first this many bytes of stdout and let git run to its end.
   * Without it, stdout above 64 MiB fails the command.
   */
  readonly maxOutputBytes?: number
}

/** Runs one git command and resolves its stdout. */
export type GitRunner = (args: readonly string[], options: GitRunOptions) => Promise<string>

/**
 * Environment for non-interactive git: no terminal prompts.
 * @param env - base environment.
 * @returns environment for git child processes.
 */
export function gitEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...env, GIT_TERMINAL_PROMPT: '0' }
}

const MAX_BUFFER = 64 * 1024 * 1024
const MAX_STDERR = 1024 * 1024

/**
 * Default runner backed by the `git` executable on PATH.
 * @param args - git arguments.
 * @param options - working directory, timeout, extra environment, cancellation, and output cut.
 * @returns stdout.
 */
export const runGit: GitRunner = (args, options) => new Promise((resolve, reject) => {
  const child = spawn('git', [...args], { cwd: options.cwd, env: { ...gitEnvironment(), ...options.env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const limit = options.maxOutputBytes ?? MAX_BUFFER
  const out: Buffer[] = []
  const err: Buffer[] = []
  let outBytes = 0
  let errBytes = 0
  let stopped: string | undefined
  const stop = (why: string): void => {
    stopped ??= why
    child.kill('SIGTERM')
  }
  const timer = setTimeout(() => { stop(`超时（${options.timeoutMs} ms）后终止`) }, options.timeoutMs)
  const onAbort = (): void => { stop('被取消后终止') }
  options.signal?.addEventListener('abort', onAbort, { once: true })
  if (options.signal?.aborted === true) onAbort()
  child.stdout.on('data', (chunk: Buffer) => {
    if (outBytes < limit) out.push(chunk.subarray(0, limit - outBytes))
    outBytes += chunk.length
    if (outBytes > limit && options.maxOutputBytes === undefined) stop(`输出超过 ${MAX_BUFFER} 字节后终止`)
  })
  child.stderr.on('data', (chunk: Buffer) => {
    if (errBytes < MAX_STDERR) err.push(chunk.subarray(0, MAX_STDERR - errBytes))
    errBytes += chunk.length
  })
  child.on('error', (error) => {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
    reject(new GitError(args, error.message))
  })
  child.on('close', (code) => {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
    const stdout = Buffer.concat(out).toString('utf8')
    if (code === 0 && stopped === undefined) {
      resolve(stdout)
      return
    }
    const stderr = Buffer.concat(err).toString('utf8').trim()
    const output = stderr === '' ? stdout.trim() : stderr
    reject(new GitError(args, stopped === undefined ? output || `退出码 ${String(code)}` : `${stopped}${output === '' ? '' : `：${output}`}`))
  })
})

/** Environment variables the helper reads; set only on git child processes. */
const USERNAME_VARIABLE = 'DSH_REPO_GIT_USERNAME'
const TOKEN_VARIABLE = 'DSH_REPO_GIT_TOKEN'

/** Answers git's `get` request from the two variables and ignores `store` and `erase`. */
const HELPER = `!f() { test "$1" = get || exit 0; printf 'username=%s\\npassword=%s\\n' "$${USERNAME_VARIABLE}" "$${TOKEN_VARIABLE}"; }; f`

/**
 * Environment that makes one git process answer the credential request for
 * `hostUrl` with the given token. Existing `GIT_CONFIG_COUNT` entries are
 * kept; the helper list for that host is reset first so a stale password from
 * another helper cannot shadow the token.
 * @param hostUrl - `scheme://host[:port]…` the token belongs to.
 * @param username - HTTP username sent with the token.
 * @param token - token value, free of control characters.
 * @param env - environment of the git process before this call.
 * @returns variables to add to the git process environment.
 */
export function credentialEnvironment(hostUrl: string, username: string, token: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const prefix = new URL(hostUrl)
  const key = `credential.${prefix.protocol}//${prefix.host}.helper`
  const parsed = Number(env.GIT_CONFIG_COUNT ?? '0')
  const base = Number.isInteger(parsed) && parsed > 0 ? parsed : 0
  return {
    GIT_CONFIG_COUNT: String(base + 2),
    [`GIT_CONFIG_KEY_${base}`]: key,
    [`GIT_CONFIG_VALUE_${base}`]: '',
    [`GIT_CONFIG_KEY_${base + 1}`]: key,
    [`GIT_CONFIG_VALUE_${base + 1}`]: HELPER,
    [USERNAME_VARIABLE]: username,
    [TOKEN_VARIABLE]: token,
  }
}
