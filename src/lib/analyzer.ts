import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs/promises';
import crypto from 'crypto';
import { parseCodeFile, type FunctionInfo } from './parser';
import { inferRelationshipsWithLLM, type LLMFileDigest } from './llm';
import { prisma } from './db';
import { generateGraphPreview } from './graphPreview';
import { deleteImageFromS3 } from './s3';

const execAsync = promisify(exec);

const CACHE_DIR = path.join(process.cwd(), '.gitweb-cache', 'repos');

// Increment this version whenever visualization logic changes
const GRAPH_VERSION = '2';

// In-memory cache for GitHub commits with TTL
const githubCommitCache = new Map<string, { sha: string; timestamp: number }>();
const GITHUB_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Function to clean up expired cache entries
function cleanupExpiredCache() {
  const now = Date.now();
  for (const [key, value] of githubCommitCache.entries()) {
    if (now - value.timestamp > GITHUB_CACHE_TTL) {
      githubCommitCache.delete(key);
    }
  }
}

// Clean up cache every 10 minutes
setInterval(cleanupExpiredCache, 10 * 60 * 1000);

// Global API call counter
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
      // Extract S3 key from signed URL
      const urlObj = new URL(url);
      const key = urlObj.pathname.substring(1).split('?')[0]; // Remove query parameters
      
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
        return; // Already clean
      }

      await removeDirectoryForce(repoPath);
      
      // Double-check it's actually gone
      const stillExists = await fs.access(repoPath).then(() => true).catch(() => false);
      if (!stillExists) {
        return; // Success
      }

      // If still exists, retry
      if (attempt < maxRetries - 1) {
        console.warn(`Local git repo still exists after cleanup attempt ${attempt + 1}, retrying...`);
        await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1)));
      }
    } catch (error) {
      if (attempt === maxRetries - 1) {
        // Last attempt failed, throw error
        throw new Error(`Failed to cleanup local git repo after ${maxRetries} attempts: ${error instanceof Error ? error.message : String(error)}`);
      }
      // Wait before retry
      await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1)));
    }
  }

  // Final verification
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

export async function analyzeRepository(repoUrl: string, onProgress?: (progress: string) => void): Promise<AnalysisResult> {
  // Extract repo name from URL
  const match = repoUrl.match(/github\.com\/([^\/]+)\/([^\/]+?)(\.git)?$/);
  if (!match) {
    throw new Error('Invalid GitHub URL');
  }

  const [, owner, repo] = match;
  const repoName = `${owner}_${repo}`;
  const repoPath = path.join(CACHE_DIR, repoName);

  // Record search analytics
  await prisma.repoSearch.create({
    data: {
      repoUrl,
      repoName,
      owner,
      repo,
    },
  }).catch(err => console.warn('Failed to record search analytics:', err));

  onProgress?.('Checking cache...');

  // Check cache first
  const cachedResult = await checkCache(repoUrl, repoPath);
  if (cachedResult) {
    onProgress?.('Loaded from cache');
    return cachedResult;
  }

  onProgress?.('Cloning repository...');
  // Clone or update repository (cache cleanup already done in checkCache if needed)
  await ensureRepository(repoUrl, repoPath);

  // Get current commit hash
  const commitHash = await getCommitHash(repoPath);

  onProgress?.('Analyzing code structure...');
  // Analyze the repository
  const result = await analyzeCode(repoPath, onProgress);

  onProgress?.('Building relationships...');
  // Enhance relationships with LLM analysis
  const enhancedResult = await enhanceWithLLM(result, repoPath, onProgress);

  // Cache the result
  await cacheResult(repoUrl, repoName, owner, repo, commitHash, result.files.nodes.length, enhancedResult);

  onProgress?.('Finalizing...');
  return enhancedResult;
}

async function checkCache(repoUrl: string, repoPath: string): Promise<AnalysisResult | null> {
  try {
    // Check database cache first (fast)
    const cached = await prisma.repositoryCache.findUnique({
      where: { repoUrl },
    });

    if (!cached || !cached.commitHash) {
      return null; // No cache, need to analyze
    }

    // Check if it's been more than 1 day since last update - if so, force full refresh
    const ONE_DAY_MS = 24 * 60 * 60 * 1000; // 1 day in milliseconds
    const timeSinceLastUpdate = Date.now() - cached.updatedAt.getTime();
    const needsFullRefresh = timeSinceLastUpdate > ONE_DAY_MS;

    if (needsFullRefresh) {
      // Force full refresh: clean up old S3 images AND local git repo
      await cleanupOldS3Images(cached.imageUrl, cached.previewImageUrl);
      
      // Critical: ensure cleanup completes before proceeding
      try {
        await cleanupLocalGitRepo(repoPath);
      } catch (cleanupError) {
        console.error('Failed to cleanup local git repo during refresh:', cleanupError);
        // Continue anyway - ensureRepository will handle it
      }
      
      return null;
    }

    // Extract the git SHA from the combined hash (format: "gitSHA:contentHash")
    const storedGitSha = cached.commitHash.includes(':') 
      ? cached.commitHash.split(':')[0] 
      : cached.commitHash;

    // Get latest commit from GitHub (with caching)
    const latestCommit = await getLatestCommitFromGitHub(repoUrl);
    if (!latestCommit) {
      // Can't verify - but don't force refresh if cache is recent
      if (timeSinceLastUpdate < 6 * 60 * 60 * 1000) { // Less than 6 hours old
        // Silently use cache - this is normal when GitHub API is rate limited or down
        return cached.analysisResult as unknown as AnalysisResult;
      }
      return null; // Can't check and cache is old, force refresh
    }

    // If git commit hasn't changed, return cached result
    if (storedGitSha === latestCommit) {
      return cached.analysisResult as unknown as AnalysisResult;
    }

    // Git commit has changed, need to re-analyze: clean up old resources
    await cleanupOldS3Images(cached.imageUrl, cached.previewImageUrl);
    
    // Critical: ensure cleanup completes before proceeding
    try {
      await cleanupLocalGitRepo(repoPath);
    } catch (cleanupError) {
      console.error('Failed to cleanup local git repo during update:', cleanupError);
      // Continue anyway - ensureRepository will handle it
    }
  } catch (error) {
    console.warn('Cache check error:', error);
    // Cache miss - silently continue
  }

  return null;
}

async function getLatestCommitFromGitHub(repoUrl: string): Promise<string | null> {
  // Check in-memory cache first
  const cached = githubCommitCache.get(repoUrl);
  if (cached && (Date.now() - cached.timestamp) < GITHUB_CACHE_TTL) {
    return cached.sha;
  }

  try {
    const match = repoUrl.match(/github\.com\/([^\/]+)\/([^\/]+?)(\.git)?$/);
    if (!match) return null;

    const [, owner, repo] = match;
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/commits/HEAD`;
    
    // Add GitHub token if available (increases rate limit from 60/hr to 5000/hr)
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
    
    // Cache the result
    githubCommitCache.set(repoUrl, { sha, timestamp: Date.now() });
    
    return sha;
  } catch (error) {
    return null;
  }
}

async function getCommitHash(repoPath: string): Promise<string> {
  try {
    const { stdout } = await execAsync('git rev-parse HEAD', { cwd: repoPath });
    return stdout.trim();
  } catch (error) {
    // If local git fails, get from GitHub API
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
    // Create content hash from analysis result + version
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

    // Check if images already exist and are up to date
    const cached = await prisma.repositoryCache.findUnique({
      where: { repoUrl },
      select: { imageUrl: true, previewImageUrl: true, commitHash: true }
    });

    // Extract stored content hash
    const storedContentHash = cached?.commitHash?.includes(':') 
      ? cached.commitHash.split(':')[1] 
      : null;

    const isContentMatch = storedContentHash === contentHash;
    const hasValidFullImage = cached?.imageUrl && isContentMatch;
    const hasValidPreviewImage = cached?.previewImageUrl && isContentMatch;

    let imageUrl: string | null = null;
    let previewImageUrl: string | null = null;

    // Generate full image only if it doesn't exist or content changed
    if (!hasValidFullImage) {
      imageUrl = await generateGraphPreview(analysisResult, repoUrl, false);
    } else {
      imageUrl = cached!.imageUrl;
    }

    // Generate preview image only if it doesn't exist or content changed
    if (!hasValidPreviewImage) {
      previewImageUrl = await generateGraphPreview(analysisResult, repoUrl, true);
    } else {
      previewImageUrl = cached!.previewImageUrl;
    }

    if (!imageUrl || !previewImageUrl) {
      console.error(`Failed to get/generate images for ${repoUrl}`);
      return;
    }

    await prisma.repositoryCache.upsert({
      where: { repoUrl },
      update: {
        commitHash: combinedHash,
        fileCount,
        analysisResult: analysisResult as any,
        imageUrl,
        previewImageUrl,
        updatedAt: new Date(),
      },
      create: {
        repoUrl,
        repoName,
        owner,
        repo,
        commitHash: combinedHash,
        fileCount,
        analysisResult: analysisResult as any,
        imageUrl,
        previewImageUrl,
      },
    });
  } catch (error) {
    console.error(`Failed to cache result for ${repoUrl}:`, error);
  }
}

async function ensureRepository(repoUrl: string, repoPath: string): Promise<void> {
  const maxRetries = 2;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // CRITICAL: Verify directory doesn't exist before cloning
      const dirExists = await fs.access(repoPath).then(() => true).catch(() => false);
      
      if (dirExists) {
        // Directory exists - remove it completely with verification
        await removeDirectoryForce(repoPath);
        
        // Wait for filesystem to catch up
        await new Promise(resolve => setTimeout(resolve, 150));
        
        // Verify it's actually gone
        const stillExists = await fs.access(repoPath).then(() => true).catch(() => false);
        if (stillExists) {
          throw new Error(`Directory ${repoPath} still exists after forced removal`);
        }
      }

      // Ensure parent directory exists
      await fs.mkdir(path.dirname(repoPath), { recursive: true });
      
      // Wait a moment for filesystem
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Clone fresh repository
      await execAsync(`git clone --quiet ${repoUrl} ${repoPath}`);
      
      // Verify clone was successful
      const cloneSuccess = await fs.access(path.join(repoPath, '.git')).then(() => true).catch(() => false);
      if (!cloneSuccess) {
        throw new Error('Git clone completed but .git directory not found');
      }
      
      return; // Success!
      
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      
      // Clean up any partial clone
      try {
        await removeDirectoryForce(repoPath);
        await new Promise(resolve => setTimeout(resolve, 200));
      } catch (cleanupError) {
        console.warn('Failed to cleanup after clone error:', cleanupError);
      }
      
      // If this was our last retry, throw
      if (attempt === maxRetries - 1) {
        throw new Error(`Failed to clone repository after ${maxRetries} attempts: ${lastError.message}`);
      }
      
      // Wait before retry
      console.warn(`Clone attempt ${attempt + 1} failed, retrying...`);
      await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }

  // Should never reach here, but just in case
  throw new Error(`Failed to clone repository: ${lastError?.message || 'Unknown error'}`);
}

async function removeDirectoryForce(dirPath: string): Promise<void> {
  const maxRetries = 3;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // Check if directory exists
      const dirExists = await fs.access(dirPath).then(() => true).catch(() => false);
      if (!dirExists) {
        return; // Directory already gone, success
      }

      // Try multiple removal strategies in sequence
      try {
        // Strategy 1: Node.js fs.rm (fastest)
        await fs.rm(dirPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      } catch (error) {
        // Strategy 2: Shell rm -rf
        try {
          await execAsync(`rm -rf "${dirPath}"`);
        } catch (rmError) {
          // Strategy 3: chmod then rm -rf (for permission issues)
          await execAsync(`chmod -R 777 "${dirPath}" 2>/dev/null || true && rm -rf "${dirPath}"`);
        }
      }

      // Wait a bit for filesystem to catch up
      await new Promise(resolve => setTimeout(resolve, 100));

      // Verify directory is actually gone
      const stillExists = await fs.access(dirPath).then(() => true).catch(() => false);
      if (!stillExists) {
        return; // Successfully removed
      }

      // Directory still exists, prepare for retry
      lastError = new Error(`Directory still exists after removal attempt ${attempt + 1}`);
      
      // Wait longer before retry
      if (attempt < maxRetries - 1) {
        await new Promise(resolve => setTimeout(resolve, 200 * (attempt + 1)));
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      
      // Wait before retry
      if (attempt < maxRetries - 1) {
        await new Promise(resolve => setTimeout(resolve, 200 * (attempt + 1)));
      }
    }
  }

  // If we get here, all retries failed
  throw new Error(`Failed to remove directory after ${maxRetries} attempts: ${lastError?.message || 'Unknown error'}`);
}

async function isDirectoryCleanForClone(dirPath: string): Promise<boolean> {
  try {
    // Check if directory exists
    await fs.access(dirPath);
    
    // Check if it's empty
    const entries = await fs.readdir(dirPath);
    if (entries.length === 0) {
      return true; // Empty directory is clean
    }
    
    // Check if it contains only allowed files/directories
    const allowedEntries = ['.git', '.gitignore', 'README.md', 'LICENSE'];
    const hasOnlyAllowed = entries.every(entry => allowedEntries.includes(entry));
    
    if (!hasOnlyAllowed) {
      return false; // Contains unexpected files
    }
    
    // If it has .git, check if it's a valid repo
    if (entries.includes('.git')) {
      try {
        await execAsync('git fsck --no-progress', { cwd: dirPath });
        return true; // Valid git repo
      } catch {
        return false; // Corrupted git repo
      }
    }
    
    return true; // Only allowed non-git files
  } catch {
    return true; // Directory doesn't exist, so it's clean
  }
}

async function analyzeCode(repoPath: string, onProgress?: (progress: string) => void): Promise<AnalysisResult> {
  const fileNodes: FileNode[] = [];
  const fileEdges: Edge[] = [];
  const fileImports = new Map<string, Set<string>>();
  const fileFunctions = new Map<string, Set<string>>();
  const functionCalls = new Map<string, Set<string>>();

  let fileCount = 0;
  const maxFiles = 100; // Limit to prevent freeze on large repos

  // First, collect all file paths
  const allFiles: {filePath: string, relativePath: string}[] = [];
  await walkDirectory(repoPath, repoPath, async (filePath, relativePath) => {
    if (!shouldSkipFile(relativePath)) {
      allFiles.push({filePath, relativePath});
    }
  });

  // Limit to maxFiles
  const filesToProcess = allFiles.slice(0, maxFiles);

  // Process files in parallel batches for better performance
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

    // Process batch results
    for (const result of batchResults) {
      processedCount++;
      
      // Only update progress every 10 files to reduce overhead
      if (processedCount % 10 === 0 || processedCount === filesToProcess.length) {
        onProgress?.(`Analyzing file ${processedCount}/${filesToProcess.length}...`);
      }

      if (!result.success || !result.analysis) continue;

      // Add file node
      fileNodes.push({
        id: result.fileId,
        label: result.fileName,
        file: result.fileId,
      });

      // Store imports
      if (result.analysis.imports.length > 0) {
        fileImports.set(result.fileId, new Set(result.analysis.imports));
      }

      // Store functions and their calls
      if (result.analysis.functions.length > 0) {
        const functions = new Set<string>(result.analysis.functions.map((f: FunctionInfo) => f.name));
        fileFunctions.set(result.fileId, functions);
        
        // Store function calls
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

  // Create file edges from imports
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

  // Create edges based on function calls between files
  functionCalls.forEach((calls, sourceFile) => {
    calls.forEach((call) => {
      // Find which file contains this function
      fileFunctions.forEach((functions, targetFile) => {
        if (targetFile !== sourceFile && functions.has(call)) {
          fileEdges.push({
            id: `${sourceFile}-calls-${targetFile}::${call}`,
            source: sourceFile,
            target: targetFile,
          });
        }
      });
    });
  });

  // Add directory-based relationships
  fileNodes.forEach((node, i) => {
    fileNodes.slice(i + 1).forEach((otherNode) => {
      const nodeDir = path.dirname(node.id);
      const otherDir = path.dirname(otherNode.id);
      
      // Files in same directory often relate
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
    // Skip LLM analysis for very small repos (< 5 files) - not worth the API call
    if (result.files.nodes.length < 5) {
      onProgress?.('Skipping AI analysis for small repository...');
      return result;
    }

    // Create file digests for LLM analysis
    onProgress?.('Creating file summaries for AI...');
    const fileDigests: LLMFileDigest[] = [];

    // Process files in parallel for speed
    const digestPromises = result.files.nodes.map(async (node) => {
      const fullPath = path.join(repoPath, node.id);
      try {
        const content = await fs.readFile(fullPath, 'utf-8');
        const parsed = parseCodeFile(content, node.id);

        const digest: LLMFileDigest = {
          filePath: node.id,
          size: content.length,
          preview: content.slice(0, 1500), // Reduced from 2000 for faster processing
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

    // Filter out nulls and add to fileDigests
    const validDigests = (await Promise.all(digestPromises)).filter(d => d !== null) as LLMFileDigest[];
    fileDigests.push(...validDigests);

    // Use LLM to infer relationships
    onProgress?.('Analyzing relationships with AI...');
    const llmResult = await inferRelationshipsWithLLM(fileDigests, {
      maxFiles: 20, // Limit to prevent excessive API usage
    });

    if (llmResult) {
      apiCallCount++;
      onProgress?.('Processing AI results...');

      // Add LLM-inferred relationships
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

  // Fallback to basic heuristics if LLM fails
  onProgress?.('Enhancing relationships...');
  const enhancedEdges = [...result.files.edges];

  // Look for common patterns
  result.files.nodes.forEach((node, i) => {
    result.files.nodes.slice(i + 1).forEach((otherNode) => {
      // Files in same directory often relate
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

      // Files with similar names might relate
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
      // Skip common directories
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
    // JavaScript/TypeScript
    '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
    // Python
    '.py', '.pyw', '.pyx',
    // Java/JVM
    '.java', '.kt', '.kts', '.scala', '.groovy',
    // C/C++
    '.c', '.cpp', '.cc', '.cxx', '.h', '.hpp', '.hh', '.hxx',
    // C#/.NET
    '.cs', '.fs', '.vb',
    // Go
    '.go',
    // Rust
    '.rs',
    // Ruby
    '.rb', '.rake',
    // PHP
    '.php', '.phtml',
    // Swift/Objective-C
    '.swift', '.m', '.mm',
    // Web
    '.vue', '.svelte', '.astro',
    // Dart
    '.dart',
    // Shell
    '.sh', '.bash', '.zsh', '.fish',
    // R
    '.r', '.R',
    // Julia
    '.jl',
    // Lua
    '.lua',
    // Elixir
    '.ex', '.exs',
    // Haskell
    '.hs',
    // OCaml
    '.ml', '.mli',
    // Erlang
    '.erl',
    // Clojure
    '.clj', '.cljs', '.cljc',
    // Perl
    '.pl', '.pm',
    // SQL
    '.sql',
    // Other
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
  // Simple resolution - find file that matches the import
  const normalized = importPath.replace(/^[\.\/]+/, '').replace(/\.(js|ts|jsx|tsx)$/, '');
  
  for (const file of allFiles) {
    const fileNormalized = file.id.replace(/\.(js|ts|jsx|tsx)$/, '');
    if (fileNormalized.endsWith(normalized)) {
      return file.id;
    }
  }

  return null;
}
