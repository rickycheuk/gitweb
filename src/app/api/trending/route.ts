import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { checkAndGenerateImage } from '@/lib/graphPreview';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const period = searchParams.get('period') || 'daily';

    let dateFilter: Date;
    const now = new Date();

    switch (period) {
      case 'weekly':
        dateFilter = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        break;
      case 'monthly':
        dateFilter = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        break;
      case 'daily':
      default:
        dateFilter = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        break;
    }

    // Get trending repositories based on unique user views, not total requests
    let analyticsRecords;
    try {
      analyticsRecords = await prisma.repoAnalytics.findMany({
        where: {
          requestedAt: {
            gte: dateFilter,
          },
        },
        select: {
          repoUrl: true,
          repoName: true,
          owner: true,
          repo: true,
          userId: true,
          requestedAt: true,
        },
        orderBy: {
          requestedAt: 'desc',
        },
      });
    } catch (dbError) {
      console.error('Trending API error:', dbError);
      // Return empty trending data when database is unavailable
      return NextResponse.json({
        trending: [],
        period,
        totalCount: 0,
        message: 'Trending data temporarily unavailable due to database connectivity issues'
      });
    }

    // Group by repository and count unique users
    const repoStats = new Map<string, {
      repoUrl: string;
      repoName: string;
      owner: string;
      repo: string;
      uniqueUsers: Set<string>;
      lastRequestedAt: Date;
    }>();

    for (const record of analyticsRecords) {
      const key = record.repoUrl;
      if (!repoStats.has(key)) {
        repoStats.set(key, {
          repoUrl: record.repoUrl,
          repoName: record.repoName,
          owner: record.owner,
          repo: record.repo,
          uniqueUsers: new Set<string>(),
          lastRequestedAt: record.requestedAt,
        });
      }

      const stats = repoStats.get(key)!;

      // Track unique users (including null for anonymous users)
      // For anonymous users (userId = null), each request counts as a unique view
      // since we can't deduplicate anonymous users across sessions
      if (record.userId) {
        stats.uniqueUsers.add(record.userId);
      } else {
        // For anonymous users, use a unique identifier based on timestamp + random
        // This ensures each anonymous request counts as a unique user view
        stats.uniqueUsers.add(`anon_${record.requestedAt.getTime()}_${Math.random()}`);
      }

      // Update last requested time if this is more recent
      if (record.requestedAt > stats.lastRequestedAt) {
        stats.lastRequestedAt = record.requestedAt;
      }
    }

    // Convert to array and sort by unique user count, then by most recent
    const trendingRepos = Array.from(repoStats.values())
      .map(stats => ({
        repoUrl: stats.repoUrl,
        repoName: stats.repoName,
        owner: stats.owner,
        repo: stats.repo,
        _count: {
          repoUrl: stats.uniqueUsers.size, // Unique user count
        },
        _max: {
          requestedAt: stats.lastRequestedAt,
        },
      }))
      .sort((a, b) => {
        // Sort by unique user count descending, then by most recent
        if (b._count.repoUrl !== a._count.repoUrl) {
          return b._count.repoUrl - a._count.repoUrl;
        }
        return b._max.requestedAt.getTime() - a._max.requestedAt.getTime();
      })
      .slice(0, 10); // Top 10 trending repos

    // Debug: Check environment variables
    // Get image URLs from repository cache
    const repoUrls = trendingRepos.map(item => item.repoUrl);
    const cachedRepos = await prisma.repositoryCache.findMany({
      where: {
        repoUrl: {
          in: repoUrls,
        },
      },
      select: {
        repoUrl: true,
        imageUrl: true,
        previewImageUrl: true,
        commitHash: true,
      },
    });

    const imageUrlMap = new Map(cachedRepos.map(repo => [repo.repoUrl, repo.previewImageUrl || repo.imageUrl]));

    // Ensure all repos have preview images
    await Promise.allSettled(
      cachedRepos.map(async (repo) => {
        try {
          await checkAndGenerateImage(repo.repoUrl, true);
        } catch (error) {
          // Silently fail - preview will be null
        }
      })
    );

    // Re-fetch to get the updated preview URLs
    const updatedCachedRepos = await prisma.repositoryCache.findMany({
      where: {
        repoUrl: {
          in: repoUrls,
        },
      },
      select: {
        repoUrl: true,
        imageUrl: true,
        previewImageUrl: true,
        commitHash: true,
      },
    });
    
    const finalImageUrlMap = new Map(updatedCachedRepos.map(repo => [repo.repoUrl, repo.previewImageUrl || repo.imageUrl]));

    // Format the response
    const formattedTrending = trendingRepos.map((item) => ({
      repoUrl: item.repoUrl,
      repoName: item.repoName,
      owner: item.owner,
      repo: item.repo,
      requestCount: item._count.repoUrl,
      lastRequestedAt: item._max.requestedAt,
      imageUrl: finalImageUrlMap.get(item.repoUrl) || null,
    }));

    return NextResponse.json({
      period,
      trending: formattedTrending,
    });
  } catch (error) {
    console.error('Trending API error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch trending repositories' },
      { status: 500 }
    );
  }
}