'use client'

type GithubSource = {
  owner: string
  repo: string
  path: string
  ref: string
}

const defaultBranchCache = new Map<string, string>()

export function parseGithubInput(input: string) {
  const trimmed = input.trim()
  if (!trimmed) {
    throw new Error('Please enter a GitHub URL or github:owner/repo path')
  }

  if (trimmed.startsWith('github:')) {
    return parseGithubShorthand(trimmed.slice('github:'.length))
  }

  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return parseGithubUrl(trimmed)
  }

  if (!trimmed.includes('://') && trimmed.split('/').length >= 2) {
    return parseGithubShorthand(trimmed)
  }

  throw new Error('Unsupported GitHub source format')
}

function parseGithubShorthand(rawValue: string) {
  const value = rawValue.replace(/^github:/i, '')
  const segments = value.split('/').filter(Boolean)
  if (segments.length < 2) {
    throw new Error('Expected github:owner/repo[/path]')
  }
  const [ownerSegment, repoSegment, ...pathSegments] = segments
  if (!ownerSegment || !repoSegment) {
    throw new Error('Expected github:owner/repo[/path]')
  }
  const ownerValue = ownerSegment.includes(':') ? ownerSegment.split(':').pop() ?? ownerSegment : ownerSegment
  const repoParts = repoSegment.split('@')
  const repoName = repoParts[0]
  const refPart = repoParts[1]
  if (!ownerValue || !repoName) {
    throw new Error('Expected github:owner/repo[/path]')
  }
  const path = pathSegments.join('/')
  return { owner: ownerValue, repo: repoName, ref: refPart, path }
}

function parseGithubUrl(raw: string) {
  const url = new URL(raw)
  if (!url.hostname.includes('github.com')) {
    throw new Error('Only github.com URLs are supported')
  }
  const [, owner, repo, view, ...rest] = url.pathname.split('/')
  if (!owner || !repo) {
    throw new Error('Invalid GitHub URL')
  }
  let ref = ''
  let path = ''
  if (view === 'tree' || view === 'blob') {
    ref = rest.shift() ?? ''
    path = rest.join('/')
  } else {
    path = rest.join('/')
  }
  return { owner, repo, ref, path }
}

export async function resolveGithubSource(input: string): Promise<GithubSource> {
  const parsed = parseGithubInput(input)
  const owner = parsed.owner
  const repo = parsed.repo
  const path = (parsed.path ?? '').replace(/^\/+/, '')
  const ref = parsed.ref || (await getDefaultBranch(owner, repo))
  return { owner, repo, path, ref }
}

async function getDefaultBranch(owner: string, repo: string) {
  const cacheKey = `${owner}/${repo}`
  const cached = defaultBranchCache.get(cacheKey)
  if (cached) {
    return cached
  }
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
    headers: { Accept: 'application/vnd.github+json' },
    cache: 'force-cache',
  })
  if (!res.ok) {
    throw new Error(`Failed to load repo info (${res.status})`)
  }
  const data = (await res.json()) as { default_branch?: string }
  const branch = data.default_branch || 'main'
  defaultBranchCache.set(cacheKey, branch)
  return branch
}

type GithubTreeEntry = {
  path: string
  type: 'blob' | 'tree'
  size?: number
}

type GithubTreeResponse = {
  tree: GithubTreeEntry[]
}

export async function fetchGithubTreeEntries(source: GithubSource) {
  const url = `https://api.github.com/repos/${source.owner}/${source.repo}/git/trees/${source.ref}?recursive=1`
  const response = await fetch(url, {
    headers: { Accept: 'application/vnd.github+json' },
    cache: 'no-store',
  })
  if (response.status === 403) {
    throw new Error('GitHub rate limit reached (403). Please wait a few minutes and try again.')
  }
  if (!response.ok) {
    throw new Error(`Failed to load repository tree (${response.status})`)
  }
  const data = (await response.json()) as GithubTreeResponse
  if (!Array.isArray(data.tree)) {
    throw new Error('Unexpected response from GitHub tree API')
  }
  return data.tree
}

export function joinGithubPath(base: GithubSource, child: string) {
  const path = base.path ? `${base.path}/${child}` : child
  return { ...base, path }
}

export function buildRawUrl(source: GithubSource, path: string) {
  const cleanPath = path.replace(/^\/+/, '')
  return `https://raw.githubusercontent.com/${source.owner}/${source.repo}/${source.ref}/${cleanPath}`
}

function encodeURIComponentPath(path: string) {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

