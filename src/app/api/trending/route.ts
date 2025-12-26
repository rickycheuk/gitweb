import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { checkAndGenerateImage } from '@/lib/graphPreview';
import { getLatestPreviewImageFromS3 } from '@/lib/s3';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const period = searchParams.get('period') || 'weekly';

    let dateFilter: Date | null = null;
    const now = new Date();

    switch (period) {
      case 'monthly':
        dateFilter = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        break;
      case 'alltime':
        dateFilter = null; // No date filter - get all time data
        break;
      case 'weekly':
      default:
        dateFilter = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        break;
    }

    // Get trending repositories based on unique user views, not total requests
    let analyticsRecords;
    try {
      const whereClause = dateFilter 
        ? { requestedAt: { gte: dateFilter } }
        : {};
      
      analyticsRecords = await prisma.repoAnalytics.findMany({
        where: whereClause,
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
        analysisResult: true,
      },
    });

    // Create a map of repo URLs to their cached data
    const cachedReposMap = new Map(cachedRepos.map(repo => [repo.repoUrl, repo]));

    // Format the response with latest preview images from S3
    // This ensures we always show the most recent preview image from S3
    // We query S3 in parallel for all repos to get the latest preview images
    const formattedTrending = await Promise.all(
      trendingRepos.map(async (item) => {
        const cached = cachedReposMap.get(item.repoUrl);
        
        // Try to get the latest preview image from S3
        // This will return the most recent preview image even if there are multiple versions
        let imageUrl: string | null = null;
        try {
          const latestPreview = await getLatestPreviewImageFromS3(item.repoUrl);
          if (latestPreview) {
            imageUrl = latestPreview;
            
            // Update the cache with the latest preview URL for future requests
            // This is done in the background and doesn't block the response
            // Add retry logic for deadlock errors
            if (cached && latestPreview !== cached.previewImageUrl) {
              // Retry logic for deadlock/conflict errors
              const updateCache = async (maxRetries = 3) => {
                for (let i = 0; i < maxRetries; i++) {
                  try {
                    await prisma.repositoryCache.update({
                      where: { repoUrl: item.repoUrl },
                      data: { previewImageUrl: latestPreview },
                    });
                    return; // Success, exit
                  } catch (err: unknown) {
                    // If it's a deadlock/conflict error (P2034) and we have retries left
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const prismaError = err as any;
                    if (prismaError?.code === 'P2034' && i < maxRetries - 1) {
                      // Wait a random amount of time (exponential backoff) before retrying
                      await new Promise(resolve => setTimeout(resolve, Math.random() * 100 * (i + 1)));
                      continue;
                    }
                    // Otherwise, log and give up
                    console.warn(`Failed to update cache with latest preview for ${item.repoUrl}:`, err);
                    return;
                  }
                }
              };
              updateCache().catch(() => {
                // Silent failure for background operation
              });
            }
          } else {
            // Fallback to cached URL if no images found in S3
            imageUrl = cached?.previewImageUrl || cached?.imageUrl || null;
          }
        } catch (error) {
          console.warn(`Failed to get latest preview from S3 for ${item.repoUrl}, using cached:`, error);
          // Fallback to cached URL on error to ensure we still return results
          imageUrl = cached?.previewImageUrl || cached?.imageUrl || null;
        }
        
        return {
          repoUrl: item.repoUrl,
          repoName: item.repoName,
          owner: item.owner,
          repo: item.repo,
          requestCount: item._count.repoUrl,
          lastRequestedAt: item._max.requestedAt,
          imageUrl,
        };
      })
    );

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