import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs/promises';
import crypto from 'crypto';
import { createGunzip } from 'node:zlib';
import { parseCodeFile, type FunctionInfo } from './parser';
import { inferRelationshipsWithLLM, type LLMFileDigest } from './llm';
import { prisma } from './db';
import { generateGraphPreview, extractS3KeyFromUrl } from './graphPreview';
import { deleteImageFromS3, checkImageExistsInS3 } from './s3';
import tar from 'tar-stream';
import type { Headers as TarHeaders } from 'tar-stream';
import type { PassThrough } from 'node:stream';

const execAsync = promisify(exec);

const CACHE_DIR = path.join(process.cwd(), '.gitweb-cache', 'repos');

const GRAPH_VERSION = '2';

const githubCommitCache = new Map<string, { sha: string; timestamp: number }>();
const githubTreeCache = new Map<string, { tree: unknown[]; timestamp: number }>();
const GITHUB_CACHE_TTL = 5 * 60 * 1000;
const MAX_TARBALL_BYTES = 25 * 1024 * 1024;
const MAX_FILE_BYTES = 1_200_000;
const TAR_FETCH_TIMEOUT_MS = 6000;

function cleanupExpiredCache() {
  const now = Date.now();
  for (const [key, value] of githubCommitCache.entries()) {
    if (now - value.timestamp > GITHUB_CACHE_TTL) {
      githubCommitCache.delete(key);
    }
  }
  for (const [key, value] of githubTreeCache.entries()) {
    if (now - value.timestamp > GITHUB_CACHE_TTL) {
      githubTreeCache.delete(key);
    }
  }
}

setInterval(cleanupExpiredCache, 10 * 60 * 1000);

let apiCallCount = 0;

export function getApiCallCount(): number {
  return apiCallCount;
}

export function resetApiCallCount(): void {
  apiCallCount = 0;
}

async function cleanupOldS3Images(imageUrl: string | null, previewImageUrl: string | null): Promise<void> {
  const urlsToDelete = [imageUrl, previewImageUrl].filter(url => url !== null) as string[];
  
  for (const url of urlsToDelete) {
    try {
      const urlObj = new URL(url);
      const key = urlObj.pathname.substring(1).split('?')[0];
      if (key) {
        await deleteImageFromS3(key);
      }
    } catch (error) {
      console.warn(`Failed to delete old S3 image: ${url}`, error);
    }
  }
}

async function cleanupLocalGitRepo(repoPath: string): Promise<void> {
  const maxRetries = 3;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const dirExists = await fs.access(repoPath).then(() => true).catch(() => false);
      if (!dirExists) {
        return;
      }

      await removeDirectoryForce(repoPath);
      
      const stillExists = await fs.access(repoPath).then(() => true).catch(() => false);
      if (!stillExists) {
        return;
      }

      if (attempt < maxRetries - 1) {
        console.warn(`Local git repo still exists after cleanup attempt ${attempt + 1}, retrying...`);
        await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1)));
      }
    } catch (error) {
      if (attempt === maxRetries - 1) {
        throw new Error(`Failed to cleanup local git repo after ${maxRetries} attempts: ${error instanceof Error ? error.message : String(error)}`);
      }
      await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1)));
    }
  }

  const finalCheck = await fs.access(repoPath).then(() => true).catch(() => false);
  if (finalCheck) {
    throw new Error(`Failed to cleanup local git repo: directory still exists after all attempts`);
  }
}

interface FileNode {
  id: string;
  label: string;
  file: string;
}

interface FunctionNode {
  id: string;
  label: string;
  file: string;
  type: 'function' | 'class' | 'method';
}

interface Edge {
  id: string;
  source: string;
  target: string;
}

interface AnalysisResult {
  files: {
    nodes: FileNode[];
    edges: Edge[];
  };
  functions: {
    nodes: FunctionNode[];
    edges: Edge[];
  };
}

type FileParseResult = {
  success: boolean;
  fileId: string;
  fileName: string;
  analysis: ReturnType<typeof parseCodeFile> | null;
};

export type ProgressCallback = (progress: string | { message: string; filesAnalyzed?: number; totalFiles?: number }) => void;

export async function analyzeRepository(repoUrl: string, onProgress?: ProgressCallback): Promise<AnalysisResult> {
  // Immediately send progress to show analysis has started
  onProgress?.({ message: 'Starting repository analysis...' });
  
  const match = repoUrl.match(/github\.com\/([^\/]+)\/([^\/]+?)(\.git)?$/);
  if (!match) {
    throw new Error('Invalid GitHub URL');
  }

  const [, owner, repo] = match;
  const repoName = `${owner}_${repo}`;

  await prisma.repoSearch.create({
    data: {
      repoUrl,
      repoName,
      owner,
      repo,
    },
  }).catch(err => console.warn('Failed to record search analytics:', err));

  onProgress?.({ message: 'Checking cache...' });
  const cachedResult = await checkCache(repoUrl, '');
  if (cachedResult) {
    // Check if cached images actually exist in S3, regenerate if missing
    onProgress?.({ message: 'Verifying cached images...' });
    const cached = await prisma.repositoryCache.findUnique({
      where: { repoUrl },
      select: { previewImageUrl: true, imageUrl: true, analysisResult: true }
    });

    if (cached) {
      let needsRegeneration = false;
      
      // Check if preview image exists in S3
      if (cached.previewImageUrl) {
        const s3Key = extractS3KeyFromUrl(cached.previewImageUrl);
        if (s3Key) {
          const exists = await checkImageExistsInS3(s3Key);
          if (!exists) {
            console.log(`Preview image not found in S3 for ${repoUrl}, will regenerate`);
            needsRegeneration = true;
          }
        }
      } else {
        needsRegeneration = true;
      }

      // If preview is missing, regenerate it
      if (needsRegeneration && cached.analysisResult) {
        onProgress?.({ message: 'Regenerating missing preview image...' });
        const analysisResult = cached.analysisResult as unknown as AnalysisResult;
        try {
          const newPreviewUrl = await generateGraphPreview(analysisResult, repoUrl, true);
          if (newPreviewUrl) {
            await prisma.repositoryCache.update({
              where: { repoUrl },
              data: { previewImageUrl: newPreviewUrl }
            });
            console.log(`Regenerated preview image for ${repoUrl}`);
          }
        } catch (error) {
          console.warn(`Failed to regenerate preview for ${repoUrl}:`, error);
        }
      }
    }

    onProgress?.({ message: 'Loaded from cache' });
    return cachedResult;
  }

  // Immediately send progress update to ensure client sees activity
  onProgress?.({ message: 'Fetching repository files...' });
  
  try {
    const files = await fetchFilesFromGitHub(owner, repo);
    
    if (files.size === 0) {
      throw new Error('No code files found in repository');
    }

    const commitHash = await getLatestCommitFromGitHub(repoUrl) || 'unknown';

    onProgress?.({ message: 'Analyzing code structure...', filesAnalyzed: 0, totalFiles: Math.min(files.size, 100) });
    const result = await analyzeCodeFromFiles(files, onProgress);

    onProgress?.({ message: 'Building relationships...' });
    const enhancedResult = await enhanceWithLLMFromFiles(result, files, onProgress);

    // Cache the result (this will try to generate images, but won't fail if images fail)
    // The analysis result is always saved, even if image generation fails
    await cacheResult(repoUrl, repoName, owner, repo, commitHash, result.files.nodes.length, enhancedResult);

    onProgress?.({ message: 'Finalizing...' });
    return enhancedResult;
  } catch (error) {
    console.error(`Error during analysis for ${repoUrl}:`, error);
    onProgress?.({ message: `Error: ${error instanceof Error ? error.message : String(error)}` });
    throw error;
  }
}

async function checkCache(repoUrl: string, _repoPath: string): Promise<AnalysisResult | null> {
  try {
    const cached = await prisma.repositoryCache.findUnique({
      where: { repoUrl },
    });

    if (!cached || !cached.commitHash) {
      return null;
    }

    const ONE_DAY_MS = 24 * 60 * 60 * 1000;
    const FIVE_MINUTES_MS = 5 * 60 * 1000;
    const timeSinceLastUpdate = Date.now() - cached.updatedAt.getTime();
    const needsFullRefresh = timeSinceLastUpdate > ONE_DAY_MS;

    if (needsFullRefresh) {
      await cleanupOldS3Images(cached.imageUrl, cached.previewImageUrl);
      return null;
    }

    if (timeSinceLastUpdate < FIVE_MINUTES_MS) {
      return cached.analysisResult as unknown as AnalysisResult;
    }

    const storedGitSha = cached.commitHash.includes(':') 
      ? cached.commitHash.split(':')[0] 
      : cached.commitHash;

    const latestCommit = await getLatestCommitFromGitHub(repoUrl);
    if (!latestCommit) {
      if (timeSinceLastUpdate < 6 * 60 * 60 * 1000) {
        return cached.analysisResult as unknown as AnalysisResult;
      }
      return null;
    }

    if (storedGitSha === latestCommit) {
      return cached.analysisResult as unknown as AnalysisResult;
    }

    await cleanupOldS3Images(cached.imageUrl, cached.previewImageUrl);
    return null;
  } catch (_error) {
    return null;
  }
}

async function getLatestCommitFromGitHub(repoUrl: string): Promise<string | null> {
  const cached = githubCommitCache.get(repoUrl);
  if (cached && (Date.now() - cached.timestamp) < GITHUB_CACHE_TTL) {
    return cached.sha;
  }

  try {
    const match = repoUrl.match(/github\.com\/([^\/]+)\/([^\/]+?)(\.git)?$/);
    if (!match) return null;

    const [, owner, repo] = match;
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/commits/HEAD`;
    
    const headers: Record<string, string> = {
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'gitweb-analyzer'
    };
    
    if (process.env.GITHUB_TOKEN) {
      headers['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`;
    }
    
    const response = await fetch(apiUrl, { headers });

    if (!response.ok) return null;
    
    const data = await response.json();
    const sha = data.sha;
    
    githubCommitCache.set(repoUrl, { sha, timestamp: Date.now() });
    
    return sha;
  } catch (_error) {
    return null;
  }
}

async function getCommitHash(repoPath: string): Promise<string> {
  try {
    const { stdout } = await execAsync('git rev-parse HEAD', { cwd: repoPath });
    return stdout.trim();
  } catch (_error) {
    const match = repoPath.match(/([^\/]+)_([^\/]+)$/);
    if (match) {
      const [, owner, repo] = match;
      const sha = await getLatestCommitFromGitHub(`https://github.com/${owner}/${repo}`);
      return sha || 'unknown';
    }
    return 'unknown';
  }
}

async function cacheResult(
  repoUrl: string,
  repoName: string,
  owner: string,
  repo: string,
  commitHash: string,
  fileCount: number,
  analysisResult: AnalysisResult
): Promise<void> {
  try {
    const contentString = JSON.stringify({
      version: GRAPH_VERSION,
      nodeCount: analysisResult.files.nodes.length + analysisResult.functions.nodes.length,
      edgeCount: analysisResult.files.edges.length + analysisResult.functions.edges.length,
      nodeIds: [...analysisResult.files.nodes, ...analysisResult.functions.nodes]
        .map(n => n.id)
        .sort()
        .slice(0, 10)
    });
    const contentHash = crypto.createHash('sha256').update(contentString).digest('hex').substring(0, 16);
    const combinedHash = commitHash ? `${commitHash}:${contentHash}` : contentHash;

    const cached = await prisma.repositoryCache.findUnique({
      where: { repoUrl },
      select: { imageUrl: true, previewImageUrl: true, commitHash: true }
    });

    const storedContentHash = cached?.commitHash?.includes(':') 
      ? cached.commitHash.split(':')[1] 
      : null;

    const isContentMatch = storedContentHash === contentHash;
    
    let imageUrl: string | null = cached?.imageUrl || null;
    let previewImageUrl: string | null = cached?.previewImageUrl || null;

    // Always generate new images - each analysis creates new previews with unique timestamps in S3
    // This ensures we always have fresh preview images in S3
    try {
      // Always generate full image (it's fast and ensures consistency)
      console.log(`Generating new full image for ${repoUrl}`);
      const generatedImageUrl = await generateGraphPreview(analysisResult, repoUrl, false);
      if (generatedImageUrl) {
        imageUrl = generatedImageUrl;
        console.log(`Successfully generated full image for ${repoUrl}: ${generatedImageUrl.substring(0, 100)}...`);
      } else {
        console.warn(`Failed to generate full image for ${repoUrl} (returned null)`);
      }

      // Always generate preview image - creates new preview with new timestamp in S3
      console.log(`Generating new preview image for ${repoUrl}`);
      const generatedPreviewUrl = await generateGraphPreview(analysisResult, repoUrl, true);
      if (generatedPreviewUrl) {
        // Verify the image was actually uploaded to S3
        const s3Key = extractS3KeyFromUrl(generatedPreviewUrl);
        if (s3Key) {
          const exists = await checkImageExistsInS3(s3Key);
          if (exists) {
            previewImageUrl = generatedPreviewUrl;
            console.log(`Successfully generated and verified preview image for ${repoUrl}: ${generatedPreviewUrl.substring(0, 100)}...`);
          } else {
            console.warn(`Preview image generated but not found in S3 for ${repoUrl}, will retry`);
            // Retry once
            const retryPreviewUrl = await generateGraphPreview(analysisResult, repoUrl, true);
            if (retryPreviewUrl) {
              previewImageUrl = retryPreviewUrl;
              console.log(`Successfully regenerated preview image for ${repoUrl}`);
            }
          }
        } else {
          previewImageUrl = generatedPreviewUrl;
        }
      } else {
        console.warn(`Failed to generate preview image for ${repoUrl} (returned null)`);
      }
    } catch (imageError) {
      console.error(`Failed to generate images for ${repoUrl}:`, imageError);
      // Continue to save the analysis result even if images fail
      // Use cached images as fallback if generation fails
      if (!imageUrl) {
        imageUrl = cached?.imageUrl || null;
      }
      if (!previewImageUrl) {
        previewImageUrl = cached?.previewImageUrl || null;
      }
    }

    // Save the analysis result regardless of whether images were generated
    // This ensures the analysis is cached and images can be generated later
    const updateData: {
      commitHash: string;
      fileCount: number;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      analysisResult: any;
      updatedAt: Date;
      imageUrl?: string | null;
      previewImageUrl?: string | null;
    } = {
      commitHash: combinedHash,
      fileCount,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      analysisResult: analysisResult as any,
      updatedAt: new Date(),
    };

    // Only update image URLs if they were generated (not null)
    // This preserves existing images if generation failed
    if (imageUrl !== null) {
      updateData.imageUrl = imageUrl;
    }
    if (previewImageUrl !== null) {
      updateData.previewImageUrl = previewImageUrl;
    }

    await prisma.repositoryCache.upsert({
      where: { repoUrl },
      update: updateData,
      create: {
        repoUrl,
        repoName,
        owner,
        repo,
        commitHash: combinedHash,
        fileCount,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        analysisResult: analysisResult as any,
        imageUrl: imageUrl || null,
        previewImageUrl: previewImageUrl || null,
      },
    });
  } catch (error) {
    console.error(`Failed to cache result for ${repoUrl}:`, error);
  }
}

async function fetchFilesFromGitHub(owner: string, repo: string): Promise<Map<string, string>> {
  const maxFiles = 500;
  const codeExtensions = ['.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.cpp', '.c', '.go', '.rs', '.rb', '.php', '.cs', '.swift', '.kt'];
  const token = process.env.GITHUB_TOKEN;
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'GitWeb-Analyzer'
  };
  if (token) {
    headers['Authorization'] = `token ${token}`;
  }

  try {
    const repoResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
      headers,
      signal: AbortSignal.timeout(3000)
    });
    if (!repoResponse.ok) {
      throw new Error(`Failed to fetch repo info: ${repoResponse.status}`);
    }
    const repoData = await repoResponse.json();
    const defaultBranch = repoData.default_branch || 'main';

    try {
      const tarballFiles = await fetchFilesViaTarball({ owner, repo, defaultBranch, token, codeExtensions, maxFiles });
      if (tarballFiles && tarballFiles.size > 0) {
        return tarballFiles;
      }
    } catch (tarballError) {
      console.warn(`Tarball fetch fallback for ${owner}/${repo}:`, tarballError);
    }

    return await fetchFilesViaTree({ owner, repo, defaultBranch, baseHeaders: headers, token, codeExtensions, maxFiles });
  } catch (error) {
    throw new Error(`Failed to fetch files from GitHub: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function fetchFilesViaTarball(params: {
  owner: string;
  repo: string;
  defaultBranch: string;
  token?: string;
  codeExtensions: string[];
  maxFiles: number;
}): Promise<Map<string, string>> {
  const { owner, repo, defaultBranch, token, codeExtensions, maxFiles } = params;
  const headers: Record<string, string> = {
    'User-Agent': 'GitWeb-Analyzer'
  };
  if (token) {
    headers['Authorization'] = `token ${token}`;
  }

  const response = await fetch(`https://codeload.github.com/${owner}/${repo}/tar.gz/${defaultBranch}`, {
    headers,
    signal: AbortSignal.timeout(TAR_FETCH_TIMEOUT_MS)
  });
  if (!response.ok) {
    throw new Error(`Tarball response status ${response.status}`);
  }

  const lengthHeader = response.headers.get('content-length');
  if (lengthHeader) {
    const tarballSize = Number(lengthHeader);
    if (!Number.isNaN(tarballSize) && tarballSize > MAX_TARBALL_BYTES) {
      throw new Error('Tarball larger than limit');
    }
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  if (buffer.byteLength === 0) {
    return new Map();
  }
  if (buffer.byteLength > MAX_TARBALL_BYTES) {
    throw new Error('Tarball buffer exceeded limit');
  }

  const files = new Map<string, string>();
  const extract = tar.extract();
  const gunzip = createGunzip();
  const skippedLargeFiles: string[] = [];

  await new Promise<void>((resolve, reject) => {
    extract.on('entry', (header: TarHeaders, stream: PassThrough, next: (error?: unknown) => void) => {
      if (files.size >= maxFiles) {
        stream.resume();
        stream.on('end', next);
        return;
      }

      if (header.type !== 'file') {
        stream.resume();
        stream.on('end', next);
        return;
      }

      const parts = header.name.split('/');
      if (parts.length <= 1) {
        stream.resume();
        stream.on('end', next);
        return;
      }

      const relativePath = parts.slice(1).join('/');
      if (!shouldIncludeCodeFile(relativePath, codeExtensions)) {
        stream.resume();
        stream.on('end', next);
        return;
      }

      const chunks: Buffer[] = [];
      let total = 0;
      let aborted = false;

      stream.on('data', (chunk: Buffer) => {
        if (aborted) {
          return;
        }
        total += chunk.length;
        if (total > MAX_FILE_BYTES) {
          aborted = true;
          skippedLargeFiles.push(relativePath);
          stream.resume();
          return;
        }
        chunks.push(chunk);
      });

      stream.on('error', reject);
      stream.on('end', () => {
        if (!aborted) {
          files.set(relativePath, Buffer.concat(chunks).toString('utf-8'));
        }
        next();
      });
    });

    extract.on('finish', resolve);
    extract.on('error', reject);
    gunzip.on('error', reject);
    gunzip.pipe(extract);
    gunzip.end(buffer);
  });

  if (skippedLargeFiles.length > 0 && files.size < maxFiles) {
    const rawHeaders: Record<string, string> = {
      'User-Agent': 'GitWeb-Analyzer'
    };
    if (token) {
      rawHeaders['Authorization'] = `token ${token}`;
    }
    const remainingCapacity = maxFiles - files.size;
    const targets = skippedLargeFiles.slice(0, remainingCapacity);
    await Promise.all(
      targets.map(async relativePath => {
        try {
          const response = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/${defaultBranch}/${relativePath}`, {
            headers: rawHeaders,
            signal: AbortSignal.timeout(5000)
          });
          if (response.ok) {
            files.set(relativePath, await response.text());
          }
        } catch (_error) {
        }
      })
    );
  }

  return files;
}

async function fetchFilesViaTree(params: {
  owner: string;
  repo: string;
  defaultBranch: string;
  baseHeaders: Record<string, string>;
  token?: string;
  codeExtensions: string[];
  maxFiles: number;
}): Promise<Map<string, string>> {
  const { owner, repo, defaultBranch, baseHeaders, token, codeExtensions, maxFiles } = params;
  const files = new Map<string, string>();
  const treeCacheKey = `${owner}/${repo}:${defaultBranch}`;
  const cachedTree = githubTreeCache.get(treeCacheKey);
  let tree: unknown[];

  if (cachedTree && Date.now() - cachedTree.timestamp < GITHUB_CACHE_TTL) {
    tree = cachedTree.tree;
  } else {
    const treeResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees/${defaultBranch}?recursive=1`, {
      headers: { ...baseHeaders },
      signal: AbortSignal.timeout(5000) 
    });
    if (!treeResponse.ok) {
      throw new Error(`Failed to fetch tree: ${treeResponse.status}`);
    }
    const treeData = await treeResponse.json();
    tree = treeData.tree || [];
    githubTreeCache.set(treeCacheKey, { tree, timestamp: Date.now() });
  }

  const codeFiles = (tree as Array<{ type: string; path: string }> )
    .filter(item => item.type === 'blob' && shouldIncludeCodeFile(item.path, codeExtensions))
    .slice(0, maxFiles);

  if (codeFiles.length === 0) {
    return files;
  }

  const rawHeaders: Record<string, string> = {
    'User-Agent': 'GitWeb-Analyzer'
  };
  if (token) {
    rawHeaders['Authorization'] = `token ${token}`;
  }

  const batchSize = 50;
  const batches = [];
  for (let i = 0; i < codeFiles.length; i += batchSize) {
    batches.push(codeFiles.slice(i, i + batchSize));
  }

  await Promise.all(
    batches.map(batch =>
      Promise.all(
        batch.map(async file => {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 5000);
          try {
            const response = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/${defaultBranch}/${file.path}`, {
              signal: controller.signal,
              headers: rawHeaders
            });
            if (response.ok) {
              const content = await response.text();
              files.set(file.path, content);
            }
          } catch (_error) {
          } finally {
            clearTimeout(timeoutId);
          }
        })
      )
    )
  );

  return files;
}

function shouldIncludeCodeFile(filePath: string, codeExtensions: string[]): boolean {
  if (!codeExtensions.some(ext => filePath.endsWith(ext))) {
    return false;
  }
  if (filePath.includes('node_modules/')) {
    return false;
  }
  if (filePath.includes('/.')) {
    return false;
  }
  const lower = filePath.toLowerCase();
  if (lower.includes('test') || lower.includes('spec')) {
    return false;
  }
  return true;
}

async function ensureRepository(_repoUrl: string, _repoPath: string): Promise<void> {
  return;
}

async function removeDirectoryForce(dirPath: string): Promise<void> {
  const maxRetries = 3;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const dirExists = await fs.access(dirPath).then(() => true).catch(() => false);
      if (!dirExists) {
        return;
      }

      try {
        await fs.rm(dirPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      } catch (_error) {
        try {
          await execAsync(`rm -rf "${dirPath}"`);
        } catch (_rmError) {
          await execAsync(`chmod -R 777 "${dirPath}" 2>/dev/null || true && rm -rf "${dirPath}"`);
        }
      }

      await new Promise(resolve => setTimeout(resolve, 100));

      const stillExists = await fs.access(dirPath).then(() => true).catch(() => false);
      if (!stillExists) {
        return;
      }

      if (attempt < maxRetries - 1) {
        lastError = new Error(`Directory still exists after removal attempt ${attempt + 1}`);
        await new Promise(resolve => setTimeout(resolve, 200 * (attempt + 1)));
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < maxRetries - 1) {
        await new Promise(resolve => setTimeout(resolve, 200 * (attempt + 1)));
      }
    }
  }

  throw new Error(`Failed to remove directory after ${maxRetries} attempts: ${lastError?.message || 'Unknown error'}`);
}

async function analyzeCodeFromFiles(files: Map<string, string>, onProgress?: ProgressCallback): Promise<AnalysisResult> {
  const fileNodes: FileNode[] = [];
  const fileEdges: Edge[] = [];
  const fileImports = new Map<string, Set<string>>();
  const fileFunctions = new Map<string, Set<string>>();
  const functionCalls = new Map<string, Set<string>>();

  const maxFiles = 100;
  const filesToProcess = Array.from(files.entries()).slice(0, maxFiles);
  const totalFiles = filesToProcess.length;
  
  if (totalFiles === 0) {
    return {
      files: { nodes: [], edges: [] },
      functions: { nodes: [], edges: [] },
    };
  }

  const results: FileParseResult[] = new Array(totalFiles);
  const concurrency = Math.min(50, totalFiles);
  let index = 0;
  let processedCount = 0;
  let lastProgressUpdate = Date.now();
  const PROGRESS_UPDATE_INTERVAL = 200; // Update every 200ms max

  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      for (;;) {
        const currentIndex = index++;
        if (currentIndex >= totalFiles) {
          break;
        }

        const [relativePath, content] = filesToProcess[currentIndex];
        try {
          const analysis = parseCodeFile(content, relativePath);
          results[currentIndex] = {
            success: true,
            fileId: relativePath,
            fileName: path.basename(relativePath),
            analysis,
          };
        } catch (_error) {
          results[currentIndex] = {
            success: false,
            fileId: relativePath,
            fileName: path.basename(relativePath),
            analysis: null,
          };
        } finally {
          processedCount += 1;
          const now = Date.now();
          // Update progress more frequently but throttle to avoid too many updates
          if (now - lastProgressUpdate >= PROGRESS_UPDATE_INTERVAL || processedCount === totalFiles) {
            lastProgressUpdate = now;
            onProgress?.({
              message: `Analyzing files... ${processedCount}/${totalFiles}`,
              filesAnalyzed: processedCount,
              totalFiles: totalFiles,
            });
          }
        }
      }
    })
  );

  for (const result of results) {
    if (!result || !result.success || !result.analysis) {
      continue;
    }

    fileNodes.push({
      id: result.fileId,
      label: result.fileName,
      file: result.fileId,
    });

    if (result.analysis.imports.length > 0) {
      fileImports.set(result.fileId, new Set(result.analysis.imports));
    }

    if (result.analysis.functions.length > 0) {
      const functions = new Set<string>(result.analysis.functions.map((f: FunctionInfo) => f.name));
      fileFunctions.set(result.fileId, functions);

      const calls = new Set<string>();
      result.analysis.functions.forEach((fn: FunctionInfo) => {
        fn.calls.forEach((call: string) => calls.add(call));
      });
      if (calls.size > 0) {
        functionCalls.set(result.fileId, calls);
      }
    }
  }

  onProgress?.({ message: 'Building file relationships...' });

  fileImports.forEach((imports, sourceFile) => {
    imports.forEach((importPath) => {
      const targetFile = resolveImport(sourceFile, importPath, fileNodes);
      if (targetFile && targetFile !== sourceFile) {
        fileEdges.push({
          id: `${sourceFile}->${targetFile}`,
          source: sourceFile,
          target: targetFile,
        });
      }
    });
  });

  functionCalls.forEach((calls, sourceFile) => {
    calls.forEach((call) => {
      const targetFile = findFileForFunction(call, fileFunctions);
      if (targetFile && targetFile !== sourceFile) {
        fileEdges.push({
          id: `${sourceFile}-calls-${targetFile}::${call}`,
          source: sourceFile,
          target: targetFile,
        });
      }
    });
  });

  fileNodes.forEach((node, i) => {
    fileNodes.slice(i + 1).forEach((otherNode) => {
      const nodeDir = path.dirname(node.id);
      const otherDir = path.dirname(otherNode.id);
      
      if (nodeDir === otherDir && nodeDir !== '.' && !hasEdge(fileEdges, node.id, otherNode.id)) {
        fileEdges.push({
          id: `${node.id}-samedir-${otherNode.id}`,
          source: node.id,
          target: otherNode.id,
        });
      }
    });
  });

  return {
    files: { nodes: fileNodes, edges: fileEdges },
    functions: { nodes: [], edges: [] },
  };
}

async function enhanceWithLLMFromFiles(result: AnalysisResult, _files: Map<string, string>, onProgress?: ProgressCallback): Promise<AnalysisResult> {
  onProgress?.({ message: 'Preparing AI analysis...' });
  
  return result;
}

async function analyzeCode(repoPath: string, onProgress?: (progress: string) => void): Promise<AnalysisResult> {
  const fileNodes: FileNode[] = [];
  const fileEdges: Edge[] = [];
  const fileImports = new Map<string, Set<string>>();
  const fileFunctions = new Map<string, Set<string>>();
  const functionCalls = new Map<string, Set<string>>();

  const maxFiles = 100;

  const allFiles: {filePath: string, relativePath: string}[] = [];
  await walkDirectory(repoPath, repoPath, async (filePath, relativePath) => {
    if (!shouldSkipFile(relativePath)) {
      allFiles.push({filePath, relativePath});
    }
  });

  const filesToProcess = allFiles.slice(0, maxFiles);

  const batchSize = 10;
  const batches = [];
  for (let i = 0; i < filesToProcess.length; i += batchSize) {
    batches.push(filesToProcess.slice(i, i + batchSize));
  }

  let processedCount = 0;
  for (const batch of batches) {
    const batchResults = await Promise.all(
      batch.map(async (file) => {
        try {
          const content = await fs.readFile(file.filePath, 'utf-8');
          const analysis = parseCodeFile(content, file.filePath);

          return {
            fileId: file.relativePath,
            fileName: path.basename(file.relativePath),
            analysis,
            success: true,
          };
        } catch (error) {
          console.error(`Error parsing ${file.relativePath}:`, error);
          return { fileId: file.relativePath, fileName: '', analysis: null, success: false };
        }
      })
    );

    for (const result of batchResults) {
      processedCount++;
      
      if (processedCount % 10 === 0 || processedCount === filesToProcess.length) {
        onProgress?.(`Analyzing file ${processedCount}/${filesToProcess.length}...`);
      }

      if (!result.success || !result.analysis) continue;

      fileNodes.push({
        id: result.fileId,
        label: result.fileName,
        file: result.fileId,
      });

      if (result.analysis.imports.length > 0) {
        fileImports.set(result.fileId, new Set(result.analysis.imports));
      }

      if (result.analysis.functions.length > 0) {
        const functions = new Set<string>(result.analysis.functions.map((f: FunctionInfo) => f.name));
        fileFunctions.set(result.fileId, functions);
        
        const calls = new Set<string>();
        result.analysis.functions.forEach((fn: FunctionInfo) => {
          fn.calls.forEach((call: string) => calls.add(call));
        });
        if (calls.size > 0) {
          functionCalls.set(result.fileId, calls);
        }
      }
    }
  }

  onProgress?.('Building file relationships...');

  fileImports.forEach((imports, sourceFile) => {
    imports.forEach((importPath) => {
      const targetFile = resolveImport(sourceFile, importPath, fileNodes);
      if (targetFile && targetFile !== sourceFile) {
        fileEdges.push({
          id: `${sourceFile}->${targetFile}`,
          source: sourceFile,
          target: targetFile,
        });
      }
    });
  });

  functionCalls.forEach((calls, sourceFile) => {
    calls.forEach((call) => {
      const targetFile = findFileForFunction(call, fileFunctions);
      if (targetFile && targetFile !== sourceFile) {
        fileEdges.push({
          id: `${sourceFile}-calls-${targetFile}::${call}`,
          source: sourceFile,
          target: targetFile,
        });
      }
    });
  });

  fileNodes.forEach((node, i) => {
    fileNodes.slice(i + 1).forEach((otherNode) => {
      const nodeDir = path.dirname(node.id);
      const otherDir = path.dirname(otherNode.id);
      
      if (nodeDir === otherDir && nodeDir !== '.' && !hasEdge(fileEdges, node.id, otherNode.id)) {
        fileEdges.push({
          id: `${node.id}-samedir-${otherNode.id}`,
          source: node.id,
          target: otherNode.id,
        });
      }
    });
  });

  return {
    files: { nodes: fileNodes, edges: fileEdges },
    functions: { nodes: [], edges: [] },
  };
}

function hasEdge(edges: Edge[], source: string, target: string): boolean {
  return edges.some(edge => edge.source === source && edge.target === target);
}

async function enhanceWithLLM(result: AnalysisResult, repoPath: string, onProgress?: (progress: string) => void): Promise<AnalysisResult> {
  onProgress?.('Preparing AI analysis...');

  try {
    if (result.files.nodes.length < 5) {
      onProgress?.('Skipping AI analysis for small repository...');
      return result;
    }

    const fileDigests: LLMFileDigest[] = [];

    const digestPromises = result.files.nodes.map(async (node) => {
      const fullPath = path.join(repoPath, node.id);
      try {
        const content = await fs.readFile(fullPath, 'utf-8');
        const parsed = parseCodeFile(content, node.id);

        const digest: LLMFileDigest = {
          filePath: node.id,
          size: content.length,
          preview: content.slice(0, 1500),
          imports: parsed.imports.map(imp => ({
            specifier: imp,
            resolved: imp,
            kind: 'es' as const,
            symbols: [imp]
          })),
          exports: parsed.functions.map(func => ({
            name: func.name,
            kind: func.type,
            isExported: true
          })),
          calls: parsed.functions.flatMap(func =>
            func.calls.map(call => ({
              callerId: node.id,
              local: call,
              imported: call,
            }))
          )
        };

        return digest;
      } catch (error) {
        console.warn(`Failed to read file ${node.id}:`, error);
        return null;
      }
    });

    const validDigests = (await Promise.all(digestPromises)).filter(d => d !== null) as LLMFileDigest[];
    fileDigests.push(...validDigests);

    onProgress?.('Analyzing relationships with AI...');
    const llmResult = await inferRelationshipsWithLLM(fileDigests, {
      maxFiles: 20,
    });

    if (llmResult) {
      apiCallCount++;
      onProgress?.('Processing AI results...');

      const enhancedEdges = [...result.files.edges];

      for (const edge of llmResult.fileEdges) {
        const edgeId = `llm-${edge.source}-${edge.target}`;
        if (!enhancedEdges.some(e => e.id === edgeId)) {
          enhancedEdges.push({
            id: edgeId,
            source: edge.source,
            target: edge.target,
          });
        }
      }

      return {
        ...result,
        files: {
          ...result.files,
          edges: enhancedEdges,
        },
      };
    }
  } catch (error) {
    console.warn('LLM enhancement failed, using basic heuristics:', error);
    onProgress?.('AI analysis failed, using basic analysis...');
  }

  onProgress?.('Enhancing relationships...');
  const enhancedEdges = [...result.files.edges];

  result.files.nodes.forEach((node, i) => {
    result.files.nodes.slice(i + 1).forEach((otherNode) => {
      const nodeDir = path.dirname(node.id);
      const otherDir = path.dirname(otherNode.id);

      if (nodeDir === otherDir && nodeDir !== '.') {
        const edgeId = `${node.id}-samedir-${otherNode.id}`;
        if (!enhancedEdges.some(e => e.id === edgeId)) {
          enhancedEdges.push({
            id: edgeId,
            source: node.id,
            target: otherNode.id,
          });
        }
      }

      const nodeBase = path.basename(node.id, path.extname(node.id));
      const otherBase = path.basename(otherNode.id, path.extname(otherNode.id));

      if (nodeBase.includes(otherBase) || otherBase.includes(nodeBase)) {
        if (nodeBase !== otherBase) {
          const edgeId = `${node.id}-similar-${otherNode.id}`;
          if (!enhancedEdges.some(e => e.id === edgeId)) {
            enhancedEdges.push({
              id: edgeId,
              source: node.id,
              target: otherNode.id,
            });
          }
        }
      }
    });
  });

  return {
    ...result,
    files: {
      ...result.files,
      edges: enhancedEdges,
    },
  };
}

async function walkDirectory(
  dirPath: string,
  basePath: string,
  callback: (filePath: string, relativePath: string) => Promise<void>
): Promise<void> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    const relativePath = path.relative(basePath, fullPath);

    if (entry.isDirectory()) {
      if (shouldSkipDirectory(entry.name)) continue;
      await walkDirectory(fullPath, basePath, callback);
    } else if (entry.isFile()) {
      await callback(fullPath, relativePath);
    }
  }
}

function shouldSkipDirectory(name: string): boolean {
  const skipDirs = [
    'node_modules', '.git', 'dist', 'build', '.next', 'out',
    '__pycache__', '.pytest_cache', 'venv', 'env', '.venv',
    'target', 'bin', 'obj', '.idea', '.vscode', 'coverage',
  ];
  return skipDirs.includes(name) || name.startsWith('.');
}

function shouldSkipFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  const codeExtensions = [
    '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
    '.py', '.pyw', '.pyx',
    '.java', '.kt', '.kts', '.scala', '.groovy',
    '.c', '.cpp', '.cc', '.cxx', '.h', '.hpp', '.hh', '.hxx',
    '.cs', '.fs', '.vb',
    '.go',
    '.rs',
    '.rb', '.rake',
    '.php', '.phtml',
    '.swift', '.m', '.mm',
    '.vue', '.svelte', '.astro',
    '.dart',
    '.sh', '.bash', '.zsh', '.fish',
    '.r', '.R',
    '.jl',
    '.lua',
    '.ex', '.exs',
    '.hs',
    '.ml', '.mli',
    '.erl',
    '.clj', '.cljs', '.cljc',
    '.pl', '.pm',
    '.sql',
    '.zig', '.nim', '.v', '.sol',
  ];
  
  if (ext === '.md' || ext === '.txt' || ext === '.json' || ext === '.yaml' || ext === '.yml') {
    return true;
  }

  return !codeExtensions.includes(ext);
}

function resolveImport(
  sourceFile: string,
  importPath: string,
  allFiles: FileNode[]
): string | null {
  const normalized = importPath.replace(/^[\.\/]+/, '').replace(/\.(js|ts|jsx|tsx)$/, '');
  
  for (const file of allFiles) {
    const fileNormalized = file.id.replace(/\.(js|ts|jsx|tsx)$/, '');
    if (fileNormalized.endsWith(normalized)) {
      return file.id;
    }
  }

  return null;
}

function findFileForFunction(functionName: string, fileFunctions: Map<string, Set<string>>): string | null {
  for (const [file, functions] of fileFunctions.entries()) {
    if (functions.has(functionName)) {
      return file;
    }
  }
  return null;
}
