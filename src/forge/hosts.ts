/**
 * Configured and added hosts with their tokens: the host list of the
 * settings file, the token of each host read from `ctx.credentials` on every
 * request, one provider per host, git credentials for the mirrors and the
 * proxy, and the commit identity of each token account.
 *
 * @module dsh-repo/forge/hosts
 */

import type { CommitAuthor, HostCreate, HostInfo, HostsChange, RepoTarget, TokenStatus } from '../contract.ts'
import { apiBaseUrl } from '../config.ts'
import type { HostSpec } from '../config.ts'
import { RepoError, toRepoError } from '../errors.ts'
import type { HostCredentials, HostLogger } from '../host.ts'
import { GithubProvider } from '../providers/github.ts'
import { GitlabProvider } from '../providers/gitlab.ts'
import type { Provider } from '../providers/types.ts'
import { isAcceptedToken, MAX_TOKEN_LENGTH } from '../settings/store.ts'
import type { SettingsStore } from '../settings/store.ts'
import { hostOf, resolveTarget } from '../target.ts'
import type { ResolvedTarget } from '../target.ts'

/** Builds the provider of one host; tests substitute it. */
export type ProviderFactory = (spec: HostSpec, token: () => Promise<string>, timeoutMs: number) => Provider

/** Default factory: Octokit for GitHub, GitBeaker for GitLab. */
export const defaultProviderFactory: ProviderFactory = (spec, token, timeoutMs) => spec.kind === 'github'
  ? new GithubProvider(apiBaseUrl(spec), token)
  : new GitlabProvider(apiBaseUrl(spec), token, timeoutMs)

/** Credentials of a configured host for git over HTTPS. */
export interface HostGitCredentials {
  /** Normalized host address. */
  readonly hostUrl: string
  /** HTTP username git sends with the token. */
  readonly username: string
  readonly token: string
}

/** HTTP username git sends with a host's token. */
function gitUsername(kind: HostSpec['kind']): string {
  return kind === 'gitlab' ? 'oauth2' : 'x-access-token'
}

/** Rejects with the signal's reason once it aborts. */
function abortion(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason)
    else signal.addEventListener('abort', () => { reject(signal.reason) }, { once: true })
  })
}

const TOKEN_RULE = `令牌不能为空、超过 ${MAX_TOKEN_LENGTH} 个字符或包含换行等控制字符`

/** Collaborators of the host registry. */
export interface HostRegistryDeps {
  /** DSH credential store; tokens are resolved per request. */
  readonly credentials: HostCredentials
  /** Settings file holding the added hosts and the API deadline and limits. */
  readonly store: SettingsStore
  readonly factory?: ProviderFactory
  /** Reports a throwing {@link HostRegistry.onChange} listener. */
  readonly logger?: HostLogger
}

/** Hosts, their tokens, and their providers. */
export class HostRegistry {
  private readonly providers = new Map<string, Provider>()
  /** Commit identity of each host's token account, keyed by host URL and checked against the token it was read with. */
  private readonly identities = new Map<string, { readonly token: string; readonly author: Promise<CommitAuthor> }>()
  private readonly listeners = new Set<(change: HostsChange) => void>()
  private readonly factory: ProviderFactory

  /** @param deps - credential store, settings file, provider factory, and logger. */
  constructor(private readonly deps: HostRegistryDeps) {
    this.factory = deps.factory ?? defaultProviderFactory
  }

  /** @returns the configured hosts followed by the added ones. */
  all(): readonly HostSpec[] {
    return this.deps.store.all()
  }

  /** Whether any host is configured or added. */
  get configured(): boolean {
    return this.all().length > 0
  }

  /**
   * Resolve a target to its host; whether it may be reached is the catalog's decision.
   * @param repo - repository address, `host/path`, or PR/MR URL.
   * @returns the target with its host.
   * @throws {RepoError} `invalid` for an unreadable target, `not-allowed` when no configured host serves it.
   */
  resolve(repo: RepoTarget): ResolvedTarget {
    return resolveTarget(repo, this.all())
  }

  /** @returns every host with its token status. */
  async list(): Promise<readonly HostInfo[]> {
    return await Promise.all(this.all().map(spec => this.info(spec)))
  }

  /**
   * Add a host, and store its token when one is given.
   * @param host - address, kind, API address, alias, and token.
   * @returns the added host.
   * @throws {RepoError} see `DshRepoService.hostAdd`.
   */
  async add(host: HostCreate): Promise<HostInfo> {
    const token = host.token?.trim()
    if (token !== undefined && !isAcceptedToken(token)) throw new RepoError('invalid', TOKEN_RULE)
    const spec = await this.deps.store.add(host)
    try {
      if (token !== undefined) await this.storeToken(spec, token)
    } finally {
      this.notify({ kind: 'added', url: spec.url })
    }
    return await this.info(spec)
  }

  /**
   * Remove an added host and clear its token.
   * @param url - host address.
   * @throws {RepoError} see `DshRepoService.hostRemove`.
   */
  async remove(url: string): Promise<void> {
    const spec = await this.deps.store.remove(url)
    this.providers.delete(spec.url)
    this.identities.delete(spec.url)
    try {
      await this.deps.credentials.unset(spec.tokenRef)
    } catch (error) {
      throw new RepoError('unavailable', `已删除主机 ${spec.url}，但清除令牌 ${spec.tokenRef} 失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.notify({ kind: 'removed', url: spec.url })
    }
  }

  /**
   * Store or clear a host's token.
   * @param url - host address.
   * @param token - new token, or undefined to clear it.
   * @returns the host with its token status.
   * @throws {RepoError} see `DshRepoService.hostSetToken`.
   */
  async setToken(url: string, token: string | undefined): Promise<HostInfo> {
    const spec = this.deps.store.find(url)
    if (token === undefined) {
      try {
        await this.deps.credentials.unset(spec.tokenRef)
      } catch (error) {
        throw new RepoError('unavailable', `清除 ${spec.tokenRef} 失败：${error instanceof Error ? error.message : String(error)}`)
      }
    } else {
      const value = token.trim()
      if (!isAcceptedToken(value)) throw new RepoError('invalid', TOKEN_RULE)
      await this.storeToken(spec, value)
    }
    this.notify({ kind: 'token', url: spec.url })
    return await this.info(spec)
  }

  /**
   * Observe host, token, and mirror directory changes.
   * @param listener - runs after each change; a throwing listener is logged and does not affect the change.
   * @returns disposer that stops the observation.
   */
  onChange(listener: (change: HostsChange) => void): () => void {
    const entry = (change: HostsChange): void => { listener(change) }
    this.listeners.add(entry)
    return () => { this.listeners.delete(entry) }
  }

  /**
   * Tell the {@link onChange} listeners about a change; the mirror directory's changes are reported here too.
   * @param change - what changed.
   */
  notify(change: HostsChange): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(change)
      } catch (error) {
        this.deps.logger?.error?.('dsh-repo: 主机变更监听器出错：%s', error instanceof Error ? error.message : String(error))
      }
    }
  }

  /** Drop the built providers, so the next call builds them with the current API deadline. */
  resetProviders(): void {
    this.providers.clear()
  }

  /**
   * The provider of a host, built on first use.
   * @param spec - configured or added host.
   * @returns the provider.
   */
  provider(spec: HostSpec): Provider {
    const existing = this.providers.get(spec.url)
    if (existing !== undefined) return existing
    const created = this.factory(spec, () => this.token(spec), this.deps.store.settings().timeoutMs)
    this.providers.set(spec.url, created)
    return created
  }

  /**
   * Credentials git uses to reach an address under a configured host.
   * @param url - accepted git address.
   * @returns the credentials.
   * @throws {RepoError} `not-allowed` without a configured host, `unauthenticated` without a token.
   */
  async gitCredentials(url: string): Promise<HostGitCredentials> {
    const spec = this.hostOf(url)
    return { hostUrl: spec.url, username: gitUsername(spec.kind), token: await this.token(spec) }
  }

  /**
   * Commit identity of the token account of the host `url` belongs to; read
   * once per token value.
   * @param url - accepted git address under a configured host.
   * @param signal - caller cancellation of the wait.
   * @returns the identity.
   * @throws {RepoError} `not-allowed` without a configured host, and the classified failure of the host's current-user API.
   */
  async tokenIdentity(url: string, signal: AbortSignal | undefined): Promise<CommitAuthor> {
    const spec = this.hostOf(url)
    const token = await this.token(spec)
    let entry = this.identities.get(spec.url)
    if (entry?.token !== token) {
      const settings = this.deps.store.settings()
      // Concurrent pushes share this read, so only the deadline cancels it.
      const author = this.provider(spec).currentUser({ signal: AbortSignal.timeout(settings.timeoutMs), limits: settings.limits })
      entry = { token, author }
      this.identities.set(spec.url, entry)
      // A failed read is not kept, so the next push asks again.
      author.catch(() => { if (this.identities.get(spec.url) === entry) this.identities.delete(spec.url) })
    }
    try {
      return await (signal === undefined ? entry.author : Promise.race([entry.author, abortion(signal)]))
    } catch (error) {
      throw toRepoError(error, `读取 ${spec.url} 令牌账号的提交身份（作者默认用令牌账号）`)
    }
  }

  private hostOf(url: string): HostSpec {
    const spec = hostOf(url, this.all())
    if (spec === undefined) throw new RepoError('not-allowed', `${url} 不属于已配置的主机`)
    return spec
  }

  private async storeToken(spec: HostSpec, value: string): Promise<void> {
    try {
      await this.deps.credentials.set(spec.tokenRef, value)
    } catch (error) {
      throw new RepoError('unavailable', `保存 ${spec.tokenRef} 失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async info(spec: HostSpec): Promise<HostInfo> {
    let token: TokenStatus
    try {
      const info = await this.deps.credentials.describe(spec.tokenRef)
      token = { configured: info.configured, ...info.source === undefined ? {} : { source: info.source }, writable: info.writable }
    } catch (error) {
      token = { configured: false, writable: false, error: error instanceof Error ? error.message : String(error) }
    }
    return {
      kind: spec.kind,
      url: spec.url,
      ...spec.apiUrl === undefined ? {} : { apiUrl: spec.apiUrl },
      ...spec.alias === undefined ? {} : { alias: spec.alias },
      tokenRef: spec.tokenRef,
      origin: this.deps.store.isAdded(spec.url) ? 'added' : 'config',
      token,
    }
  }

  private async token(spec: HostSpec): Promise<string> {
    const resolved = await this.deps.credentials.resolve(spec.tokenRef)
    if (resolved === undefined || resolved.value === '') throw new RepoError('unauthenticated', `${spec.url} 的令牌 ${spec.tokenRef} 未设置（在 DSH 凭据库或同名环境变量中设置）`)
    if (!isAcceptedToken(resolved.value)) throw new RepoError('unauthenticated', `${spec.tokenRef} 的值不能用作令牌：不能超过 ${MAX_TOKEN_LENGTH} 个字符或包含换行等控制字符`)
    return resolved.value
  }
}
