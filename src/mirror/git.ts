/**
 * The local `git` executable: non-interactive runs with a bounded timeout,
 * and access tokens handed to one git process through a host-scoped
 * credential helper that reads them from that process's environment, so a
 * token never appears in argv, `.git/config`, or git output.
 *
 * @module dsh-repo/mirror/git
 */

import { execFile } from 'node:child_process'

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
}

/** Runs one git command and resolves its stdout. */
export type GitRunner = (args: readonly string[], options: GitRunOptions) => Promise<string>

/**
 * Environment for non-interactive git: no terminal prompts, and SSH in batch
 * mode unless the user configured their own SSH command.
 * @param env - base environment.
 * @returns environment for git child processes.
 */
export function gitEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env, GIT_TERMINAL_PROMPT: '0' }
  if (env.GIT_SSH_COMMAND === undefined && env.GIT_SSH === undefined) next.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes'
  return next
}

/**
 * Default runner backed by the `git` executable on PATH.
 * @param args - git arguments.
 * @param options - working directory, timeout, extra environment, and cancellation.
 * @returns stdout.
 */
export const runGit: GitRunner = (args, options) => new Promise((resolve, reject) => {
  execFile('git', [...args], {
    cwd: options.cwd,
    env: { ...gitEnvironment(), ...options.env },
    timeout: options.timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
    ...options.signal === undefined ? {} : { signal: options.signal },
  }, (error, stdout, stderr) => {
    if (error === null) {
      resolve(stdout)
      return
    }
    const output = (stderr.trim() === '' ? `${stdout}${stderr}` : stderr).trim()
    const killed = (error as { killed?: boolean }).killed === true
    reject(new GitError(args, killed ? `超时（${options.timeoutMs} ms）或被取消后终止${output === '' ? '' : `：${output}`}` : output || error.message))
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
