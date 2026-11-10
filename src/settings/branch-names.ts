/**
 * Branch names: which names git accepts, and the naming rules of the branches
 * new workspaces push to — a template that generates a name when none is
 * given, and an optional regular expression every new branch must match. The
 * settings page bundle imports this file too, so it has no imports.
 *
 * A template is text with placeholders:
 * - `{session}`: the first 8 letters and digits of the creating Session's id
 *   in lowercase, so the workspaces of one Session continue one branch; 8
 *   random hexadecimal digits without a Session;
 * - `{random}`: 8 random hexadecimal digits;
 * - `{date}`: the local date as `YYYYMMDD`.
 *
 * @module dsh-repo/settings/branch-names
 */

/** Branch names git accepts and that cannot be mistaken for options; see {@link isBranchName}. */
const BRANCH = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*\.lock$)(?!.*\/$)[^\s~^:?*[\\\u0000-\u001f\u007f]+$/

/**
 * Whether a name is a branch git accepts and that cannot be mistaken for an
 * option: no leading `-` or `/`, no `..`, `//`, trailing `/` or `.lock`, no
 * whitespace, control characters, or `~^:?*[\`, and not `@`.
 * @param value - candidate branch name, without `refs/heads/`.
 * @returns whether it is accepted.
 */
export function isBranchName(value: string): boolean {
  return BRANCH.test(value) && !value.startsWith('/') && value !== '@'
}

/** Template of a new workspace's branch while none is configured. */
export const DEFAULT_BRANCH_TEMPLATE = 'dsh/{session}'

/** Longest branch name template or pattern. */
export const MAX_BRANCH_RULE_LENGTH = 200

/** Placeholders a template may use, in the order the settings page lists them. */
export const BRANCH_PLACEHOLDERS = ['session', 'random', 'date'] as const

/** One placeholder of a template. */
export type BranchPlaceholder = typeof BRANCH_PLACEHOLDERS[number]

/** Values the placeholders of a template take. */
export type BranchNameValues = Readonly<Record<BranchPlaceholder, string>>

/** Values used to check a template: the longest each placeholder produces. */
const SAMPLE_VALUES: BranchNameValues = { session: 'a1b2c3d4', random: 'e5f6a7b8', date: '20260101' }

const PLACEHOLDER = /\{([^{}]*)\}/g

/**
 * Fill a template's placeholders.
 * @param template - template checked by {@link templateProblem}.
 * @param values - the value of each placeholder.
 * @returns the branch name.
 */
export function renderBranchName(template: string, values: BranchNameValues): string {
  return template.replace(PLACEHOLDER, (whole, name: string) => (BRANCH_PLACEHOLDERS as readonly string[]).includes(name) ? values[name as BranchPlaceholder] : whole)
}

/**
 * Why a template cannot name new branches.
 * @param template - candidate template.
 * @returns the reason, or undefined when it can.
 */
export function templateProblem(template: string): string | undefined {
  if (template.trim() === '') return '分支命名模板不能为空'
  if (template.length > MAX_BRANCH_RULE_LENGTH) return `分支命名模板最多 ${MAX_BRANCH_RULE_LENGTH} 个字符`
  const unknown = [...template.matchAll(PLACEHOLDER)].map(match => match[1] ?? '').find(name => !(BRANCH_PLACEHOLDERS as readonly string[]).includes(name))
  if (unknown !== undefined) return `分支命名模板里的 {${unknown}} 不是可用的占位符；可用 ${BRANCH_PLACEHOLDERS.map(name => `{${name}}`).join('、')}`
  if (!template.includes('{session}') && !template.includes('{random}')) return '分支命名模板要包含 {session} 或 {random}，否则每个工作区都会用同一个分支'
  const sample = renderBranchName(template, SAMPLE_VALUES)
  if (!isBranchName(sample)) return `分支命名模板生成的名字不是合法的分支名：${sample}`
  return undefined
}

/**
 * Why a pattern cannot check branch names.
 * @param pattern - candidate regular expression; empty means no rule.
 * @returns the reason, or undefined when it can.
 */
export function patternProblem(pattern: string): string | undefined {
  if (pattern === '') return undefined
  if (pattern.length > MAX_BRANCH_RULE_LENGTH) return `分支名规则最多 ${MAX_BRANCH_RULE_LENGTH} 个字符`
  try {
    new RegExp(pattern, 'u')
  } catch (error) {
    return `分支名规则不是合法的正则表达式：${error instanceof Error ? error.message : String(error)}`
  }
  return undefined
}

/**
 * Whether a branch name matches a pattern.
 * @param name - branch name.
 * @param pattern - regular expression checked by {@link patternProblem}; empty matches every name.
 * @returns whether the name matches. The expression is unanchored: write `^` and `$` to match the whole name.
 */
export function matchesBranchPattern(name: string, pattern: string): boolean {
  return pattern === '' || new RegExp(pattern, 'u').test(name)
}

/**
 * Why a template and a pattern cannot be used together.
 * @param template - candidate template.
 * @param pattern - candidate pattern; empty means no rule.
 * @returns the reason, or undefined when the template is valid, the pattern is valid, and the names the template generates match the pattern.
 */
export function branchRulesProblem(template: string, pattern: string): string | undefined {
  const problem = templateProblem(template) ?? patternProblem(pattern)
  if (problem !== undefined) return problem
  const sample = renderBranchName(template, SAMPLE_VALUES)
  if (!matchesBranchPattern(sample, pattern)) return `分支命名模板生成的名字（例如 ${sample}）不符合分支名规则 ${pattern}`
  return undefined
}

/**
 * The name a template generates, shown to the user: each placeholder replaced by a description.
 * @param template - template checked by {@link templateProblem}.
 * @param withSession - whether the workspace belongs to a Session; without one `{session}` is random.
 * @returns the readable name, e.g. `dsh/会话号`.
 */
export function describeBranchTemplate(template: string, withSession: boolean): string {
  return renderBranchName(template, { session: withSession ? '会话号' : '随机串', random: '随机串', date: '日期' })
}
