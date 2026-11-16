/**
 * Validation of the git names every layer accepts: branch names and full
 * commit ids. Each caller that takes one from outside checks it here, so the
 * service, the mirrors, the workspaces, the proxy, and the catalog accept
 * exactly the same names.
 *
 * @module dsh-repo/refs
 */

import { RepoError } from './errors.ts'
import { isBranchName } from './settings/branch-names.ts'

/** A full SHA-1 or SHA-256 commit id in lowercase hexadecimal. */
export const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

export { isBranchName }

/**
 * Whether a value is a full commit id.
 * @param value - candidate commit id.
 * @returns whether it is 40 or 64 lowercase hexadecimal digits.
 */
export function isCommitId(value: string): boolean {
  return COMMIT_ID.test(value)
}

/**
 * Validate a branch name.
 * @param value - candidate branch name.
 * @param label - field name for the message.
 * @throws {RepoError} `invalid` unless {@link isBranchName} accepts it.
 */
export function requireBranch(value: string, label: string): void {
  if (!isBranchName(value)) throw new RepoError('invalid', `${label}不合法：${value}`)
}

/**
 * Validate a full commit id.
 * @param value - candidate commit id.
 * @param label - field name for the message.
 * @throws {RepoError} `invalid` unless {@link isCommitId} accepts it.
 */
export function requireCommit(value: string, label: string): void {
  if (!isCommitId(value)) throw new RepoError('invalid', `${label}必须是完整的十六进制提交 id：${value}`)
}
