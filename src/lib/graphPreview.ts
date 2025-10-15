import { createCanvas } from 'canvas';
import { uploadImageToS3, checkImageExistsInS3 } from './s3';
import { prisma } from './db';
import { forceSimulation, forceLink, forceManyBody, forceCenter, forceX, forceY } from 'd3-force';
import crypto from 'crypto';

// Increment this version whenever visualization logic changes to force regeneration
const GRAPH_VERSION = '2';

function extractS3KeyFromUrl(url: string): string | null {
  try {
    const urlObj = new URL(url);
    const key = urlObj.pathname.substring(1);
    return key;
  } catch (error) {
    return null;
  }
}

async function getLatestCommitFromGitHub(repoUrl: string): Promise<string | null> {
  try {
    const match = repoUrl.match(/github\.com\/([^\/]+)\/([^\/]+?)(\.git)?$/);
    if (!match) return null;

    const [, owner, repo] = match;
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/commits/HEAD`;
    
    const response = await fetch(apiUrl, {
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'gitweb-analyzer'
      }
    });

    if (!response.ok) return null;
    
    const data = await response.json();
    return data.sha;
  } catch (error) {
    return null;
  }
}

interface AnalysisResult {
  files: {
    nodes: Array<{ id: string; label: string; file: string }>;
    edges: Array<{ id: string; source: string; target: string }>;
  };
  functions: {
    nodes: Array<{ id: string; label: string; file: string; type: string }>;
    edges: Array<{ id: string; source: string; target: string }>;
  };
}

export async function checkAndGenerateImage(repoUrl: string, isPreview: boolean = false): Promise<string | null> {
  try {
    // Extract repo name from URL
    const match = repoUrl.match(/github\.com\/([^\/]+)\/([^\/]+?)(\.git)?$/);
    if (!match) {
      console.error('Invalid GitHub URL:', repoUrl);
      return null;
    }

    const [, owner, repo] = match;
    const repoName = `${owner}_${repo}`;

    // Get current commit hash from GitHub API
    const currentCommitHash = await getLatestCommitFromGitHub(repoUrl);
    if (!currentCommitHash) {
      return null;
    }

    // Check if image already exists and is up to date
    const cached = await prisma.repositoryCache.findUnique({
      where: { repoUrl },
      select: { imageUrl: true, previewImageUrl: true, analysisResult: true, commitHash: true }
    });

    // Create a content hash that includes both the analysis result and graph version
    // This ensures regeneration when either the code changes OR the visualization logic changes
    let currentContentHash = '';
    if (cached?.analysisResult) {
      const analysisResult = cached.analysisResult as unknown as AnalysisResult;
      const contentString = JSON.stringify({
        version: GRAPH_VERSION,
        nodeCount: analysisResult.files.nodes.length + analysisResult.functions.nodes.length,
        edgeCount: analysisResult.files.edges.length + analysisResult.functions.edges.length,
        nodeIds: [...analysisResult.files.nodes, ...analysisResult.functions.nodes]
          .map(n => n.id)
          .sort()
          .slice(0, 10) // Sample first 10 for hash
      });
      currentContentHash = crypto.createHash('sha256').update(contentString).digest('hex').substring(0, 16);
    }

    // Extract stored content hash from commitHash field (format: "sha:hash")
    const storedContentHash = cached?.commitHash?.includes(':') 
      ? cached.commitHash.split(':')[1] 
      : null;

    // Check if we have a valid cached image (commit matches AND content hash matches)
    const isContentMatch = storedContentHash === currentContentHash && currentContentHash !== '';
    const hasValidFullImage = cached?.imageUrl && isContentMatch;
    const hasValidPreviewImage = cached?.previewImageUrl && isContentMatch;

    if (isPreview) {
      // For previews, we need a valid full image first
      if (hasValidPreviewImage && cached!.previewImageUrl) {
        const cachedUrl = cached!.previewImageUrl;
        const isSignedUrl = cachedUrl.includes('?');
        
        if (isSignedUrl) {
          const s3Key = extractS3KeyFromUrl(cachedUrl);
          if (s3Key) {
            const imageExists = await checkImageExistsInS3(s3Key);
            if (imageExists) {
              return cachedUrl;
            }
          }
        }
      }

      // Ensure we have a full image before generating preview
      let shouldGenerateFullImage = !hasValidFullImage;
      
      if (hasValidFullImage && cached!.imageUrl) {
        const s3Key = extractS3KeyFromUrl(cached!.imageUrl);
        if (s3Key) {
          const imageExists = await checkImageExistsInS3(s3Key);
          if (!imageExists) {
            shouldGenerateFullImage = true;
          }
        }
      }
      
      if (shouldGenerateFullImage && cached?.analysisResult) {
        const analysisResult = cached.analysisResult as unknown as AnalysisResult;
        const fullImageUrl = await generateGraphPreview(analysisResult, repoUrl, false);

        // Store commit hash with content hash for cache validation
        const combinedHash = currentCommitHash ? `${currentCommitHash}:${currentContentHash}` : currentContentHash;
        
        await prisma.repositoryCache.update({
          where: { repoUrl },
          data: { imageUrl: fullImageUrl, commitHash: combinedHash }
        });
      }

      // Now generate the preview
      if (cached?.analysisResult) {
        const analysisResult = cached.analysisResult as unknown as AnalysisResult;
        const previewImageUrl = await generateGraphPreview(analysisResult, repoUrl, true);

        await prisma.repositoryCache.update({
          where: { repoUrl },
          data: { previewImageUrl: previewImageUrl }
        });

        return previewImageUrl;
      }
    } else {
      // For full images
      if (hasValidFullImage && cached!.imageUrl) {
        const cachedUrl = cached!.imageUrl;
        const isSignedUrl = cachedUrl.includes('?');
        
        if (isSignedUrl) {
          const s3Key = extractS3KeyFromUrl(cachedUrl);
          if (s3Key) {
            const imageExists = await checkImageExistsInS3(s3Key);
            if (imageExists) {
              // After returning the full image, check if preview exists and generate if not
              if (!hasValidPreviewImage && cached?.analysisResult) {
                const analysisResult = cached.analysisResult as unknown as AnalysisResult;
                const previewImageUrl = await generateGraphPreview(analysisResult, repoUrl, true);
                
                await prisma.repositoryCache.update({
                  where: { repoUrl },
                  data: { previewImageUrl: previewImageUrl }
                });
              }
              return cachedUrl;
            }
          }
        }
      }

      // Generate the full image
      if (cached?.analysisResult) {
        const analysisResult = cached.analysisResult as unknown as AnalysisResult;
        const imageUrl = await generateGraphPreview(analysisResult, repoUrl, false);

        // Store commit hash with content hash for cache validation
        const combinedHash = currentCommitHash ? `${currentCommitHash}:${currentContentHash}` : currentContentHash;

        await prisma.repositoryCache.update({
          where: { repoUrl },
          data: { imageUrl: imageUrl, commitHash: combinedHash }
        });

        // After generating full image, also generate preview if it doesn't exist
        if (!hasValidPreviewImage) {
          const previewImageUrl = await generateGraphPreview(analysisResult, repoUrl, true);
          
          await prisma.repositoryCache.update({
            where: { repoUrl },
            data: { previewImageUrl: previewImageUrl }
          });
        }

        return imageUrl;
      }
    }

    return null;
  } catch (error) {
    console.error('Failed to check/generate image:', error);
    return null;
  }
}

export async function generateGraphPreview(analysisResult: AnalysisResult, repoUrl: string, isPreview: boolean = false): Promise<string | null> {
  try {
    // Generate full-size image with D3 force-directed layout matching browser visualization
    const fullWidth = 800;
    const fullHeight = 600;
    const canvas = createCanvas(fullWidth, fullHeight);
    const ctx = canvas.getContext('2d');

    // Dark background gradient
    const gradient = ctx.createLinearGradient(0, 0, fullWidth, fullHeight);
    gradient.addColorStop(0, '#0f0f0f');
    gradient.addColorStop(1, '#1a1a1a');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, fullWidth, fullHeight);

    // Combine all nodes
    const allNodes = [...analysisResult.files.nodes, ...analysisResult.functions.nodes];
    const allEdges = [...analysisResult.files.edges, ...analysisResult.functions.edges];

    // Apply D3 force-directed layout (same as browser)
    const centerX = fullWidth / 2;
    const centerY = fullHeight / 2;
    const radius = Math.min(200, allNodes.length * 5);

    const simulationNodes = allNodes.map((node, i) => {
      const angle = (i / allNodes.length) * 2 * Math.PI;
      const x = centerX + radius * Math.cos(angle);
      const y = centerY + radius * Math.sin(angle);
      return {
        ...node,
        x,
        y,
        fx: null as number | null,
        fy: null as number | null,
      };
    });

    // Create links
    const simulationLinks = allEdges.map(edge => ({
      source: simulationNodes.find(n => n.id === edge.source),
      target: simulationNodes.find(n => n.id === edge.target),
    }));

    // Run force simulation
    const simulation = forceSimulation(simulationNodes as d3.SimulationNodeDatum[])
      .force('link', forceLink(simulationLinks as d3.SimulationLinkDatum<d3.SimulationNodeDatum>[]).distance(50))
      .force('charge', forceManyBody().strength(-200))
      .force('center', forceCenter(fullWidth / 2, fullHeight / 2))
      .force('x', forceX(fullWidth / 2).strength(0.1))
      .force('y', forceY(fullHeight / 2).strength(0.1))
      .stop();

    // Run simulation for a few ticks
    for (let i = 0; i < 100; i++) {
      simulation.tick();
    }

    // Draw edges first (so they appear behind nodes)
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
    ctx.lineWidth = 1;

    allEdges.forEach(edge => {
      const sourceNode = simulationNodes.find(n => n.id === edge.source);
      const targetNode = simulationNodes.find(n => n.id === edge.target);

      if (sourceNode && targetNode && sourceNode.x !== undefined && sourceNode.y !== undefined && targetNode.x !== undefined && targetNode.y !== undefined) {
        ctx.beginPath();
        ctx.moveTo(sourceNode.x, sourceNode.y);
        ctx.lineTo(targetNode.x, targetNode.y);
        ctx.stroke();
      }
    });

    // Draw nodes with glow effect (matching browser style)
    simulationNodes.forEach(node => {
      if (node.x === undefined || node.y === undefined) return;

      ctx.shadowColor = 'rgba(255, 255, 255, 0.5)';
      ctx.shadowBlur = 10;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
      ctx.beginPath();
      ctx.arc(node.x, node.y, 2, 0, 2 * Math.PI);
      ctx.fill();

      // Reset shadow
      ctx.shadowBlur = 0;
    });

    // If preview is requested, scale down the full image
    let finalCanvas = canvas;
    let finalWidth = fullWidth;
    let finalHeight = fullHeight;

    if (isPreview) {
      const previewWidth = 200;
      const previewHeight = 150;
      const previewCanvas = createCanvas(previewWidth, previewHeight);
      const previewCtx = previewCanvas.getContext('2d');

      // Scale down the full image to create preview
      previewCtx.drawImage(canvas, 0, 0, fullWidth, fullHeight, 0, 0, previewWidth, previewHeight);

      finalCanvas = previewCanvas;
      finalWidth = previewWidth;
      finalHeight = previewHeight;
    }

    // Convert to buffer
    let buffer: Buffer;
    try {
      buffer = finalCanvas.toBuffer('image/png');
      
      if (buffer.length === 0) {
        throw new Error('Generated buffer is empty');
      }
    } catch (error) {
      console.error('Failed to convert canvas to buffer:', error);
      throw error;
    }

    // Generate unique key
    const repoName = repoUrl.replace('https://github.com/', '').replace('/', '_');
    const key = `previews/${repoName}_${Date.now()}${isPreview ? '_preview' : ''}.png`;

    // Upload to S3
    const imageUrl = await uploadImageToS3(buffer, key);

    return imageUrl;
  } catch (error) {
    console.error('Failed to generate graph preview:', error);
    return null;
  }
}