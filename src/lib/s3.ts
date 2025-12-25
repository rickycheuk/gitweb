import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

let s3Client: S3Client | null = null;

function getS3Client(): S3Client {
  if (!s3Client) {
    // console.log('[S3] Initializing S3 client with region:', process.env.AWS_REGION || 'us-east-1');
    // console.log('[S3] Access key ID starts with:', process.env.AWS_ACCESS_KEY_ID?.substring(0, 10));
    // console.log('[S3] Secret key available:', !!process.env.AWS_SECRET_ACCESS_KEY);
    s3Client = new S3Client({
      region: process.env.AWS_REGION || 'us-east-1',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
      },
    });
  }
  return s3Client;
}

export async function uploadImageToS3(buffer: Buffer, key: string, contentType: string = 'image/png'): Promise<string> {
  const bucketName = process.env.AWS_S3_BUCKET_NAME!;

  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY || !bucketName) {
    throw new Error(`Missing AWS credentials: ACCESS_KEY_ID=${!!process.env.AWS_ACCESS_KEY_ID}, SECRET_ACCESS_KEY=${!!process.env.AWS_SECRET_ACCESS_KEY}, BUCKET_NAME=${!!bucketName}`);
  }

  // console.log(`[S3] AWS_REGION: ${process.env.AWS_REGION}`);
  // console.log(`[S3] AWS_S3_BUCKET_NAME: ${bucketName}`);
  // console.log(`[S3] AWS_ACCESS_KEY_ID: ${process.env.AWS_ACCESS_KEY_ID ? 'set' : 'not set'}`);
  // console.log(`[S3] AWS_SECRET_ACCESS_KEY: ${process.env.AWS_SECRET_ACCESS_KEY ? 'set' : 'not set'}`);
  // console.log(`[S3] Attempting to upload ${key} (${buffer.length} bytes) to ${bucketName}`);

  const command = new PutObjectCommand({
    Bucket: bucketName,
    Key: key,
    Body: buffer,
    ContentType: contentType,
    // Remove ACL since the bucket doesn't allow ACLs
  });

  try {
    console.log(`[S3] Uploading ${key} (${buffer.length} bytes) to bucket ${bucketName}`);
    const result = await getS3Client().send(command);
    console.log(`[S3] Successfully uploaded ${key}, ETag: ${result.ETag || 'N/A'}`);
  } catch (error) {
    console.error(`[S3] Failed to upload ${key} to S3:`, error);
    throw error;
  }

  // Generate a signed URL that expires in 1 year (31536000 seconds)
  const getObjectCommand = new GetObjectCommand({
    Bucket: bucketName,
    Key: key,
  });

  try {
    const signedUrl = await getSignedUrl(getS3Client(), getObjectCommand, { expiresIn: 604800 }); // 1 week = 604800 seconds
    return signedUrl;
  } catch (error) {
    console.error('Failed to generate signed URL:', error);
    // Fallback to public URL if signed URL fails
    return `https://${bucketName}.s3.amazonaws.com/${key}`;
  }
}

export async function checkImageExistsInS3(key: string): Promise<boolean> {
  const bucketName = process.env.AWS_S3_BUCKET_NAME!;

  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY || !bucketName) {
    console.error('Missing AWS credentials for checking image existence');
    return false;
  }

  const command = new HeadObjectCommand({
    Bucket: bucketName,
    Key: key,
  });

  try {
    await getS3Client().send(command);
    return true;
  } catch (error: unknown) {
    const err = error as { name?: string };
    if (err.name === 'NotFound') {
      return false;
    }
    console.error(`Error checking if image exists: ${key}`, error);
    return false;
  }
}

export async function deleteImageFromS3(key: string): Promise<boolean> {
  const bucketName = process.env.AWS_S3_BUCKET_NAME!;

  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY || !bucketName) {
    console.error('Missing AWS credentials for deleting image');
    return false;
  }

  const command = new DeleteObjectCommand({
    Bucket: bucketName,
    Key: key,
  });

  try {
    await getS3Client().send(command);
    return true;
  } catch (error: unknown) {
    console.error(`Error deleting image from S3: ${key}`, error);
    return false;
  }
}

/**
 * Get the latest preview image URL for a repository from S3
 * Searches all preview images for the repo and returns the most recent one
 */
export async function getLatestPreviewImageFromS3(repoUrl: string): Promise<string | null> {
  const bucketName = process.env.AWS_S3_BUCKET_NAME!;

  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY || !bucketName) {
    console.error('Missing AWS credentials for listing images');
    return null;
  }

  try {
    // Extract repo name from URL
    const repoName = repoUrl.replace('https://github.com/', '').replace('/', '_');
    const sanitizedRepoName = repoName.replace(/[^a-z0-9_-]/gi, '_');
    const prefix = `previews/${sanitizedRepoName}/`;

    // List all objects with this prefix
    const command = new ListObjectsV2Command({
      Bucket: bucketName,
      Prefix: prefix,
    });

    const response = await getS3Client().send(command);

    if (!response.Contents || response.Contents.length === 0) {
      return null;
    }

    // Filter for preview images only
    const previewImages = response.Contents.filter(obj => 
      obj.Key && obj.Key.includes('-preview.png')
    );

    if (previewImages.length === 0) {
      return null;
    }

    // Sort by LastModified date (most recent first)
    const sortedImages = previewImages.sort((a, b) => {
      const dateA = a.LastModified?.getTime() || 0;
      const dateB = b.LastModified?.getTime() || 0;
      return dateB - dateA;
    });

    const latestImage = sortedImages[0];
    if (!latestImage.Key) {
      return null;
    }

    // Generate a signed URL for the latest image
    const getObjectCommand = new GetObjectCommand({
      Bucket: bucketName,
      Key: latestImage.Key,
    });

    try {
      const signedUrl = await getSignedUrl(getS3Client(), getObjectCommand, { expiresIn: 604800 }); // 1 week
      return signedUrl;
    } catch (error) {
      console.error('Failed to generate signed URL for latest preview:', error);
      // Fallback to public URL
      return `https://${bucketName}.s3.amazonaws.com/${latestImage.Key}`;
    }
  } catch (error) {
    console.error(`Error getting latest preview image from S3 for ${repoUrl}:`, error);
    return null;
  }
}