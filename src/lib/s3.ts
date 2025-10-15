import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
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
    const result = await getS3Client().send(command);
  } catch (error) {
    console.error('Failed to upload to S3:', error);
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