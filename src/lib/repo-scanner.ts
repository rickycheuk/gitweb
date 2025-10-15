import { execFile } from 'child_process';
import crypto from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { promisify } from 'util';

export class RepoScannerError extends Error {
  constructor(message: string, readonly status: number = 400) {
    super(message);
    this.name = 'RepoScannerError';
  }
}

const execFileAsync = promisify(execFile);
export const CACHE_ROOT = path.join(process.cwd(), '.gitweb-cache');
const REMOTE_REPOS_ROOT = path.join(CACHE_ROOT, 'repos');
const GIT_TIMEOUT_MS = 120_000;

export interface ResolvedRepository {
  path: string;
  displayName: string;
  isRemote: boolean;
}

function isRemoteRepository(candidate: string): boolean {
  return /^https?:\/\/.+/.test(candidate) || /^git@.+:.+/.test(candidate) || candidate.startsWith('ssh://');
}

function ensureRemotePathSegments(url: string): void {
  const message =
    'Remote repository URLs must include both owner and repository name (e.g. https://github.com/owner/repo).';

  const stripGit = (value: string) => value.replace(/\.git$/i, '');

  if (/^https?:\/\//.test(url) || url.startsWith('ssh://')) {
    try {
      const parsed = new URL(url.startsWith('ssh://') && !/^ssh:\/\/[^@]+@/.test(url) ? url.replace('ssh://', 'ssh://git@') : url);
      const segments = stripGit(parsed.pathname)
        .split('/')
        .map((segment) => segment.trim())
        .filter(Boolean);
      if (segments.length < 2) {
        throw new RepoScannerError(message);
      }
    } catch (error) {
      if (error instanceof RepoScannerError) {
        throw error;
      }
      throw new RepoScannerError(message);
    }
    return;
  }

  if (/^git@/.test(url)) {
    const match = /^git@[^:]+:(.+)$/.exec(url);
    if (!match) {
      throw new RepoScannerError(message);
    }
    const segments = stripGit(match[1])
      .split('/')
      .map((segment) => segment.trim())
      .filter(Boolean);
    if (segments.length < 2) {
      throw new RepoScannerError(message);
    }
    return;
  }
}

async function execGit(args: string[], contextMessage?: string): Promise<void> {
  try {
    await execFileAsync('git', args, {
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stderr?: string };
    if (err.code === 'ENOENT') {
      throw new RepoScannerError('Git is required to clone remote repositories. Install git and try again.', 501);
    }

    const stderr = typeof err.stderr === 'string' ? err.stderr.trim() : '';
    const message = stderr || err.message || 'Unknown git error';
    throw new RepoScannerError(contextMessage ? `${contextMessage}: ${message}` : `Git command failed: ${message}`, 502);
  }
}

async function ensureRemoteRepository(url: string): Promise<{ localPath: string; displayName: string }> {
  await fs.mkdir(REMOTE_REPOS_ROOT, { recursive: true });

  const hash = crypto.createHash('sha1').update(url).digest('hex');
  const localPath = path.join(REMOTE_REPOS_ROOT, hash);
  const gitDir = path.join(localPath, '.git');

  let cloneRequired = false;
  try {
    const stats = await fs.stat(gitDir);
    cloneRequired = !stats.isDirectory();
  } catch {
    cloneRequired = true;
  }

  if (cloneRequired) {
    await fs.rm(localPath, { recursive: true, force: true });
    await execGit(['clone', '--depth', '1', url, localPath], `Failed to clone repository from ${url}`);
  } else {
    try {
      await execGit(
        ['-C', localPath, 'fetch', '--tags', '--prune', '--depth', '1', 'origin', 'HEAD'],
        `Failed to update repository ${url}`,
      );
      await execGit(['-C', localPath, 'reset', '--hard', 'FETCH_HEAD'], `Failed to sync repository ${url}`);
    } catch {
      await fs.rm(localPath, { recursive: true, force: true });
      await execGit(['clone', '--depth', '1', url, localPath], `Failed to refresh repository from ${url}`);
    }
  }

  const displayName = url.replace(/\.git$/i, '').split(/[:\/]/).filter(Boolean).pop() ?? 'repository';
  return { localPath, displayName };
}

export async function resolveRepository(input: string): Promise<ResolvedRepository> {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new RepoScannerError('Provide a repository URL or absolute path to analyze.');
  }

  if (isRemoteRepository(trimmed)) {
    ensureRemotePathSegments(trimmed);
    const { localPath, displayName } = await ensureRemoteRepository(trimmed);
    return {
      path: localPath,
      displayName,
      isRemote: true,
    };
  }

  const absPath = path.resolve(trimmed);
  const stats = await fs.stat(absPath).catch(() => {
    throw new RepoScannerError('Repository path does not exist.', 404);
  });

  if (!stats.isDirectory()) {
    throw new RepoScannerError('The target path must be a directory.');
  }

  return {
    path: absPath,
    displayName: path.basename(absPath),
    isRemote: false,
  };
}
