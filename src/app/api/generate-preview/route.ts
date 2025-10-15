import { NextRequest, NextResponse } from 'next/server';
import { checkAndGenerateImage } from '@/lib/graphPreview';
import { prisma } from '@/lib/db';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const CACHE_DIR = path.join(process.cwd(), '.gitweb-cache', 'repos');

async function getCommitHash(repoPath: string): Promise<string> {
  try {
    const { stdout } = await execAsync('git rev-parse HEAD', { cwd: repoPath });
    return stdout.trim();
  } catch (error) {
    console.error('Failed to get commit hash:', error);
    return '';
  }
}

export async function POST(request: NextRequest) {
  try {
    const { repoUrl, force } = await request.json();

    if (!repoUrl || typeof repoUrl !== 'string') {
      return NextResponse.json(
        { error: 'Repository URL is required' },
        { status: 400 }
      );
    }

    // Quick check: if preview already exists and force=false, return immediately
    if (!force) {
      const cached = await prisma.repositoryCache.findUnique({
        where: { repoUrl },
        select: { previewImageUrl: true }
      });

      if (cached?.previewImageUrl) {
        return NextResponse.json({ previewImageUrl: cached.previewImageUrl });
      }
    }

    // Check if repo exists in cache, if not create mock data
    const cached = await prisma.repositoryCache.findUnique({
      where: { repoUrl },
      select: { analysisResult: true }
    });

    if (!cached) {
      console.log(`Creating mock cache entry for ${repoUrl}`);

      // Extract repo info
      const match = repoUrl.match(/github\.com\/([^\/]+)\/([^\/]+?)(\.git)?$/);
      if (!match) {
        return NextResponse.json(
          { error: 'Invalid GitHub URL' },
          { status: 400 }
        );
      }

      const [, owner, repo] = match;
      const repoName = `${owner}_${repo}`;
      const repoPath = path.join(CACHE_DIR, repoName);

      // Get commit hash
      const commitHash = await getCommitHash(repoPath);
      if (!commitHash) {
        return NextResponse.json(
          { error: 'Repository not cloned or invalid' },
          { status: 400 }
        );
      }

      // Create mock analysis result
      const mockAnalysisResult = {
        files: {
          nodes: [
            { id: '1', label: 'main.py', file: 'main.py' },
            { id: '2', label: 'model.py', file: 'model.py' },
            { id: '3', label: 'utils.py', file: 'utils.py' }
          ],
          edges: [
            { id: 'e1', source: '1', target: '2' },
            { id: 'e2', source: '2', target: '3' }
          ]
        },
        functions: {
          nodes: [
            { id: 'f1', label: 'main()', file: 'main.py', type: 'function' },
            { id: 'f2', label: 'BitNet', file: 'model.py', type: 'class' },
            { id: 'f3', label: 'load_model()', file: 'utils.py', type: 'function' }
          ],
          edges: [
            { id: 'fe1', source: 'f1', target: 'f2' },
            { id: 'fe2', source: 'f2', target: 'f3' }
          ]
        }
      };

      await prisma.repositoryCache.create({
        data: {
          repoUrl,
          repoName: repo,
          owner,
          repo,
          commitHash,
          fileCount: 10,
          analysisResult: mockAnalysisResult
        }
      });

      console.log(`Mock cache entry created for ${repoUrl}`);
    }

    // Generate image with 8-second timeout to stay under Vercel's 10s limit
    const timeoutPromise = new Promise<string | null>((_, reject) =>
      setTimeout(() => reject(new Error('Image generation timeout')), 8000)
    );

    const generatePromise = checkAndGenerateImage(repoUrl, true);

    try {
      const previewImageUrl = await Promise.race([generatePromise, timeoutPromise]);
      return NextResponse.json({ previewImageUrl });
    } catch (timeoutError) {
      // If timeout, check if we have a cached image to return
      const fallbackCached = await prisma.repositoryCache.findUnique({
        where: { repoUrl },
        select: { previewImageUrl: true, imageUrl: true }
      });

      if (fallbackCached?.previewImageUrl || fallbackCached?.imageUrl) {
        return NextResponse.json({ 
          previewImageUrl: fallbackCached.previewImageUrl || fallbackCached.imageUrl,
          warning: 'Using cached image due to timeout'
        });
      }

      throw timeoutError;
    }
  } catch (error) {
    console.error('Preview image generation error:', error);
    return NextResponse.json(
      { error: 'Failed to generate preview image' },
      { status: 500 }
    );
  }
}