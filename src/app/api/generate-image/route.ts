import { NextRequest, NextResponse } from 'next/server';
import { checkAndGenerateImage } from '@/lib/graphPreview';
import { prisma } from '@/lib/db';

export async function POST(request: NextRequest) {
  try {
    const { repoUrl, force } = await request.json();

    if (!repoUrl || typeof repoUrl !== 'string') {
      return NextResponse.json(
        { error: 'Repository URL is required' },
        { status: 400 }
      );
    }

    // Quick check: if image already exists and force=false, return immediately
    if (!force) {
      const cached = await prisma.repositoryCache.findUnique({
        where: { repoUrl },
        select: { imageUrl: true }
      });

      if (cached?.imageUrl) {
        return NextResponse.json({ imageUrl: cached.imageUrl });
      }
    }

    // Generate image with 8-second timeout to stay under Vercel's 10s limit
    const timeoutPromise = new Promise<string | null>((_, reject) =>
      setTimeout(() => reject(new Error('Image generation timeout')), 8000)
    );

    const generatePromise = checkAndGenerateImage(repoUrl, false);

    try {
      const imageUrl = await Promise.race([generatePromise, timeoutPromise]);
      return NextResponse.json({ imageUrl });
    } catch (timeoutError) {
      // If timeout, check if we have a cached image to return
      const fallbackCached = await prisma.repositoryCache.findUnique({
        where: { repoUrl },
        select: { imageUrl: true, previewImageUrl: true }
      });

      if (fallbackCached?.imageUrl || fallbackCached?.previewImageUrl) {
        return NextResponse.json({ 
          imageUrl: fallbackCached.imageUrl || fallbackCached.previewImageUrl,
          warning: 'Using cached image due to timeout'
        });
      }

      throw timeoutError;
    }
  } catch (error) {
    console.error('Image generation error:', error);
    return NextResponse.json(
      { error: 'Failed to generate image' },
      { status: 500 }
    );
  }
}