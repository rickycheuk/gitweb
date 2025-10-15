import { prisma } from '@/lib/db';

export interface RateLimitResult {
  allowed: boolean;
  remainingNewRequests: number;
  resetTime: Date;
  error?: string;
}

export async function checkRateLimit(userId: string | null, repoUrl: string): Promise<RateLimitResult> {
  // Allow unlimited requests for unauthenticated users (for now)
  if (!userId) {
    return {
      allowed: true,
      remainingNewRequests: -1, // Unlimited
      resetTime: new Date(Date.now() + 24 * 60 * 60 * 1000) // Tomorrow
    };
  }

  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Get or create user's daily stats
    let dailyStats = await prisma.userDailyStats.findUnique({
      where: {
        userId_date: {
          userId,
          date: today
        }
      }
    });

    if (!dailyStats) {
      dailyStats = await prisma.userDailyStats.create({
        data: {
          userId,
          date: today,
          newRequestsUsed: 0,
          totalRequests: 0
        }
      });
    }

    // Check if user has already requested this repo
    const existingRequest = await prisma.userRequestHistory.findUnique({
      where: {
        userId_repoUrl: {
          userId,
          repoUrl
        }
      }
    });

    const isNewRepo = !existingRequest;
    const remainingNewRequests = Math.max(0, 10 - dailyStats.newRequestsUsed);

    // If it's a new repo and they've used all their new repo requests
    if (isNewRepo && dailyStats.newRequestsUsed >= 10) {
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);

      return {
        allowed: false,
        remainingNewRequests: 0,
        resetTime: tomorrow,
        error: 'Daily limit of 10 new repositories reached. Try again tomorrow.'
      };
    }

    return {
      allowed: true,
      remainingNewRequests: isNewRepo ? remainingNewRequests - 1 : remainingNewRequests,
      resetTime: new Date(today.getTime() + 24 * 60 * 60 * 1000)
    };
  } catch (error) {
    console.warn('Rate limit check failed, allowing request:', error);
    // Allow request if database is unavailable
    return {
      allowed: true,
      remainingNewRequests: -1, // Unlimited when DB is down
      resetTime: new Date(Date.now() + 24 * 60 * 60 * 1000)
    };
  }
}export async function recordRequest(userId: string | null, repoUrl: string, repoName: string): Promise<void> {
  console.log('[DEBUG recordRequest] Called with:', { userId, repoUrl, repoName });
  
  if (!userId) {
    console.log('[DEBUG recordRequest] No userId provided, skipping');
    return;
  }

  try {
    console.log('[DEBUG recordRequest] Starting for userId:', userId, 'repoUrl:', repoUrl);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    console.log('[DEBUG recordRequest] Today date:', today);

    // Check if this is a new repo for the user
    console.log('[DEBUG recordRequest] Checking if repo exists in history...');
    const existingRequest = await prisma.userRequestHistory.findUnique({
      where: {
        userId_repoUrl: {
          userId,
          repoUrl
        }
      }
    });

    const isNewRepo = !existingRequest;
    console.log('[DEBUG recordRequest] Is new repo:', isNewRepo, 'existingRequest:', existingRequest);

    // Record the request in history if it's new
    if (isNewRepo) {
      console.log('[DEBUG recordRequest] Creating new request history entry...');
      const createdHistory = await prisma.userRequestHistory.create({
        data: {
          userId,
          repoUrl,
          repoName
        }
      });
      console.log('[DEBUG recordRequest] Created new request history entry:', createdHistory);
    }

    // Get current daily stats
    console.log('[DEBUG recordRequest] Fetching current daily stats...');
    const currentStats = await prisma.userDailyStats.findUnique({
      where: {
        userId_date: {
          userId,
          date: today
        }
      }
    });
    console.log('[DEBUG recordRequest] Current stats:', currentStats);

    // Update daily stats
    const newRequestsUsed = isNewRepo ? (currentStats?.newRequestsUsed || 0) + 1 : currentStats?.newRequestsUsed || 0;
    const totalRequests = (currentStats?.totalRequests || 0) + 1;
    
    console.log('[DEBUG recordRequest] Updating stats - newRequestsUsed:', newRequestsUsed, 'totalRequests:', totalRequests);
    
    const updatedStats = await prisma.userDailyStats.upsert({
      where: {
        userId_date: {
          userId,
          date: today
        }
      },
      update: {
        newRequestsUsed,
        totalRequests
      },
      create: {
        userId,
        date: today,
        newRequestsUsed: isNewRepo ? 1 : 0,
        totalRequests: 1
      }
    });
    console.log('[DEBUG recordRequest] Stats updated successfully:', updatedStats);
  } catch (error) {
    console.error('[ERROR recordRequest] Failed to record request:', error);
    console.error('[ERROR recordRequest] Error stack:', error instanceof Error ? error.stack : 'No stack trace');
    // Silently fail if database is unavailable
  }
}

export async function getUserStats(userId: string | null): Promise<{ remainingNewRequests: number; resetTime: Date } | null> {
  if (!userId) return null;

  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const dailyStats = await prisma.userDailyStats.findUnique({
      where: {
        userId_date: {
          userId,
          date: today
        }
      }
    });

    console.log('[DEBUG getUserStats] Daily stats for userId:', userId, 'stats:', dailyStats);

    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const remaining = Math.max(0, 10 - (dailyStats?.newRequestsUsed || 0));
    console.log('[DEBUG getUserStats] Remaining requests:', remaining, 'newRequestsUsed:', dailyStats?.newRequestsUsed);

    return {
      remainingNewRequests: remaining,
      resetTime: tomorrow
    };
  } catch (error) {
    console.warn('Failed to get user stats:', error);
    // Return default stats if database is unavailable
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    return {
      remainingNewRequests: 10, // Assume full quota when DB is down
      resetTime: tomorrow
    };
  }
}