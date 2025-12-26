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

    // Update progress immediately to show analysis is starting
    try {
      await prisma.analysisProgress.update({
        where: { sessionId },
        data: { progress: JSON.stringify({ message: 'Initializing analysis...' }) },
      });
    } catch (err) {
      console.warn('Failed to update initial progress:', err);
    }

    // Start analysis in background
    // On Vercel, serverless functions continue executing after response is sent
    // until they hit the timeout (10s for free tier, 60s for pro)
    // We need to ensure the promise chain starts executing immediately
    const analysisPromise = analyzeRepository(repoUrl, async (progress: string | ProgressData) => {
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
        
        // Retry logic for deadlock/conflict errors
        const maxRetries = 3;
        for (let i = 0; i < maxRetries; i++) {
          try {
            await prisma.analysisProgress.update({
              where: { sessionId },
              data: { progress: progressString },
            });
            break; // Success, exit retry loop
          } catch (err: unknown) {
            // If it's a deadlock/conflict error (P2034) and we have retries left
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const prismaError = err as any;
            if (prismaError?.code === 'P2034' && i < maxRetries - 1) {
              // Wait a random amount of time before retrying
              await new Promise(resolve => setTimeout(resolve, Math.random() * 50 * (i + 1)));
              continue;
            }
            // Otherwise, log and give up
            console.warn('Failed to update progress:', err);
            break;
          }
        }
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
      console.error('Analysis failed:', error);
      try {
        await prisma.analysisProgress.update({
          where: { sessionId },
          data: {
            progress: 'error',
            error: error instanceof Error ? error.message : String(error),
          },
        });
        } catch (err) {
          console.error('Failed to save error:', err);
        }
      });

    // Ensure the promise chain starts executing by attaching error handler
    // This prevents unhandled promise rejections
    analysisPromise.catch((err) => {
      console.error('Unhandled error in analysis promise:', err);
    });

    // Trigger the analysis to start (fire and forget)
    // The promise will continue executing in the background on Vercel
    void analysisPromise;

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
