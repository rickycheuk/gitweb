import { NextRequest, NextResponse } from 'next/server';
import { analyzeRepository, getApiCallCount, resetApiCallCount } from '@/lib/analyzer';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';

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

interface ProgressEntry {
  progress: string;
  timestamp: number;
  result?: AnalysisResult;
  error?: string;
}

const progressStore = new Map<string, ProgressEntry>();

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

    analyzeRepository(repoUrl, (progress: string) => {
      progressStore.set(sessionId, { progress, timestamp: Date.now() });
    }).then((result) => {
      const finalApiCallCount = getApiCallCount();
      progressStore.set(sessionId, {
        progress: 'completed',
        timestamp: Date.now(),
        result: { ...result, apiCallCount: finalApiCallCount }
      });
    }).catch((error) => {
      progressStore.set(sessionId, {
        progress: 'error',
        timestamp: Date.now(),
        error: error.message
      });
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

  const progressData = progressStore.get(sessionId);

  if (!progressData) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }

  const oneHourAgo = Date.now() - (60 * 60 * 1000);
  for (const [key, data] of progressStore.entries()) {
    if (data.timestamp < oneHourAgo) {
      progressStore.delete(key);
    }
  }

  return NextResponse.json(progressData);
}
