import { NextRequest, NextResponse } from 'next/server';
import { analyzeRepository, getApiCallCount, resetApiCallCount, type ProgressCallback } from '@/lib/analyzer';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';

// Extend timeout for Vercel Pro (60s max) or keep at 10s for free tier
export const maxDuration = 10; // seconds

interface ProgressData {
  message: string;
  filesAnalyzed?: number;
  totalFiles?: number;
}

interface AnalysisResult {
  summary?: string;
  technologies?: string[];
  complexity?: string;
  apiCallCount?: number;
}

interface ExtendedUser {
  id: string;
  name?: string;
  email?: string;
  image?: string;
}

export async function POST(request: NextRequest) {
  try {
    const { repoUrl } = await request.json();

    if (!repoUrl || typeof repoUrl !== 'string') {
      return NextResponse.json(
        { error: 'Repository URL is required' },
        { status: 400 }
      );
    }

    const match = repoUrl.match(/github\.com\/([^\/]+)\/([^\/]+?)(\.git)?$/);
    if (!match) {
      return NextResponse.json(
        { error: 'Invalid GitHub URL format' },
        { status: 400 }
      );
    }

    const owner = match[1];
    const repo = match[2];

    try {
      const githubResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
        headers: {
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'gitweb-analyzer'
        }
      });

      if (githubResponse.status === 404) {
        return NextResponse.json(
          { error: 'Repository not found or is private. Only public repositories are supported.' },
          { status: 400 }
        );
      }

      if (githubResponse.ok) {
        const repoData = await githubResponse.json();
        if (repoData.private === true) {
          return NextResponse.json(
            { error: 'Private repositories are not supported. Please use a public repository.' },
            { status: 400 }
          );
        }
      }
    } catch (githubError) {
      console.warn('Failed to check repository visibility:', githubError);
    }

    const session = await getServerSession(authOptions);
    const userId = (session?.user as ExtendedUser)?.id || null;
    const repoName = `${owner}/${repo}`;

    try {
      await prisma.repoAnalytics.create({
        data: {
          repoUrl,
          repoName,
          owner,
          repo,
          userId,
        },
      });
    } catch (analyticsError) {
      console.warn('Failed to record analytics:', analyticsError);
    }

    const sessionId = `analysis_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    resetApiCallCount();

    // Create initial progress entry in database
    await prisma.analysisProgress.create({
      data: {
        sessionId,
        progress: 'Starting analysis...',
      },
    });

    // OPTIMIZATION: Debounce progress updates to reduce database writes
    let lastProgressUpdate = Date.now();
    const progressUpdateInterval = 500; // Update DB max once per 500ms for smoother progress

    // Start analysis in background
    analyzeRepository(repoUrl, async (progress: string | ProgressData) => {
      const now = Date.now();
      // Only update database if 500ms+ have passed since last update
      if (now - lastProgressUpdate < progressUpdateInterval) {
        return; // Skip this update
      }
      
      lastProgressUpdate = now;
      
      try {
        // Convert progress to JSON string if it's an object
        const progressString = typeof progress === 'string' 
          ? progress 
          : JSON.stringify(progress);
        
        await prisma.analysisProgress.update({
          where: { sessionId },
          data: { progress: progressString },
        });
      } catch (err) {
        console.warn('Failed to update progress:', err);
      }
    }).then(async (result) => {
      const finalApiCallCount = getApiCallCount();
      try {
        await prisma.analysisProgress.update({
          where: { sessionId },
          data: {
            progress: 'completed',
            result: { ...result, apiCallCount: finalApiCallCount } as any, // eslint-disable-line @typescript-eslint/no-explicit-any
          },
        });
      } catch (err) {
        console.error('Failed to save final result:', err);
      }
    }).catch(async (error) => {
      try {
        await prisma.analysisProgress.update({
          where: { sessionId },
          data: {
            progress: 'error',
            error: error.message,
          },
        });
      } catch (err) {
        console.error('Failed to save error:', err);
      }
    });

    return NextResponse.json({ sessionId });
  } catch (error) {
    console.error('Analysis error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Analysis failed' },
      { status: 500 }
    );
  }
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const sessionId = searchParams.get('sessionId');

  if (!sessionId) {
    return NextResponse.json({ error: 'sessionId required' }, { status: 400 });
  }

  try {
    const progressData = await prisma.analysisProgress.findUnique({
      where: { sessionId },
    });

    if (!progressData) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }

    // Clean up old progress entries (older than 1 hour)
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    await prisma.analysisProgress.deleteMany({
      where: {
        updatedAt: {
          lt: oneHourAgo,
        },
      },
    }).catch((err: unknown) => console.warn('Failed to cleanup old progress:', err));

    // Parse progress if it's JSON
    let progress: string | ProgressData = progressData.progress;
    try {
      const parsed = JSON.parse(progressData.progress);
      if (typeof parsed === 'object' && parsed.message) {
        progress = parsed;
      }
    } catch {
      // If parsing fails, use as string
      progress = progressData.progress;
    }

    return NextResponse.json({
      progress,
      timestamp: progressData.updatedAt.getTime(),
      result: progressData.result,
      error: progressData.error,
    });
  } catch (error) {
    console.error('Failed to fetch progress:', error);
    return NextResponse.json({ error: 'Failed to fetch progress' }, { status: 500 });
  }
}
