import type { RelationshipConfidence } from './types';

export interface LLMImportSummary {
  specifier: string;
  resolved?: string;
  kind: 'es' | 'require' | 'dynamic';
  symbols: string[];
}

export interface LLMFunctionSummary {
  name: string;
  exportName?: string;
  kind: string;
  isExported: boolean;
}

export interface LLMCallSummary {
  callerId: string;
  local: string;
  imported: string;
  importPath?: string;
  resolved?: string;
}

export interface LLMFileDigest {
  filePath: string;
  size: number;
  preview: string;
  imports: LLMImportSummary[];
  exports: LLMFunctionSummary[];
  calls: LLMCallSummary[];
}

export interface LLMRelationshipFileEdge {
  source: string;
  target: string;
  relationship: string;
  confidence?: RelationshipConfidence;
}

export interface LLMRelationshipFunctionEdge {
  source: { filePath: string; symbol: string };
  target: { filePath: string; symbol: string };
  relationship: string;
  confidence?: RelationshipConfidence;
  reason?: string;
}

export interface LLMRelationshipResult {
  fileEdges: LLMRelationshipFileEdge[];
  functionEdges: LLMRelationshipFunctionEdge[];
  notes: string[];
}

export interface InferRelationshipsOptions {
  maxFiles?: number;
}

const RESPONSE_SCHEMA_SNIPPET = `
{
  "fileEdges": [
    {
      "source": "path/to/source.ts",
      "target": "path/to/target.ts",
      "relationship": "imports|uses|calls",
      "confidence": "low|medium|high"
    }
  ],
  "functionEdges": [
    {
      "source": { "filePath": "path/to/source.ts", "symbol": "ExportedSymbol" },
      "target": { "filePath": "path/to/target.ts", "symbol": "OtherSymbol" },
      "relationship": "calls|uses|renders",
      "confidence": "low|medium|high",
      "reason": "short justification"
    }
  ],
  "notes": ["optional string note"]
}
`;

export async function inferRelationshipsWithLLM(
  digests: LLMFileDigest[],
  options: InferRelationshipsOptions = {},
): Promise<LLMRelationshipResult | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || !digests.length) {
    return null;
  }

  const limited = digests.slice(0, options.maxFiles || 20);

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'You are an expert software architecture analyst. Given structured summaries of project files, identify how files and exported functions relate. Respond strictly with JSON that matches the provided schema. Be concise.',
        },
        {
          role: 'user',
          content: buildPrompt(limited),
        },
      ],
      max_tokens: 800, // Reduced from 1200 for faster response
      temperature: 0.05, // More deterministic for faster, more consistent results
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  const jsonText = data.choices[0]?.message?.content;
  if (!jsonText) {
    throw new Error('No response content from OpenAI API');
  }

  // Clean up the JSON response - sometimes LLMs add extra text
  let cleanJsonText = jsonText.trim();

  // Try to extract JSON from markdown code blocks
  const jsonMatch = cleanJsonText.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
  if (jsonMatch) {
    cleanJsonText = jsonMatch[1];
  }

  // Remove control characters (like newlines in strings) that break JSON parsing
  cleanJsonText = cleanJsonText
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, '') // Remove control characters
    .replace(/\r\n/g, ' ') // Replace CRLF with space
    .replace(/\n/g, ' ') // Replace LF with space
    .replace(/\r/g, ' ') // Replace CR with space
    .replace(/\t/g, ' '); // Replace tabs with space

  // Remove any leading/trailing non-JSON text
  const jsonStart = cleanJsonText.indexOf('{');
  const jsonEnd = cleanJsonText.lastIndexOf('}');

  if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
    cleanJsonText = cleanJsonText.substring(jsonStart, jsonEnd + 1);
  }

  // Try to fix common JSON issues
  cleanJsonText = cleanJsonText
    // Remove trailing commas before closing brackets/braces
    .replace(/,(\s*[}\]])/g, '$1')
    // Fix missing commas in arrays/objects (basic heuristic)
    .replace(/}(\s*"){/g, '},$1{')
    .replace(/](\s*"){/g, '],$1{')
    .replace(/}(\s*\w)/g, '},$1')
    .replace(/](\s*\w)/g, '],$1')
    // Remove any remaining non-JSON text after the last }
    .replace(/}[^}]*$/g, '}')
    // Remove extra closing braces or brackets at the end
    .replace(/}*\s*$/g, '}');

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleanJsonText);
  } catch (error) {
    console.error('Raw LLM response:', jsonText);
    console.error('Cleaned JSON attempt:', cleanJsonText);
    // Fallback: try to extract valid JSON parts or return empty
    try {
      // Attempt to find and parse a smaller valid JSON object
      const partialMatch = cleanJsonText.match(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/);
      if (partialMatch) {
        parsed = JSON.parse(partialMatch[0]);
      } else {
        throw new Error('No valid JSON found');
      }
    } catch (fallbackError) {
      console.error('Fallback parsing failed:', (fallbackError as Error).message);
      // Return empty result instead of throwing
      return { fileEdges: [], functionEdges: [], notes: [] };
    }
  }

  return normaliseResult(parsed);
}

function buildPrompt(digests: LLMFileDigest[]): string {
  return [
    'Analyze the following project files. For each file, determine whether it references other files or exported functions. Use the exact "filePath" strings provided. Only include relationships you are confident about.',
    'Return JSON describing file-to-file and function-to-function relationships. If uncertain, omit the relationship.',
    'Your response must match the following JSON shape (omit optional fields when not needed):',
    RESPONSE_SCHEMA_SNIPPET,
    `FILES:\n${JSON.stringify(digests, null, 2)}`,
  ].join('\n\n');
}

function normaliseResult(payload: unknown): LLMRelationshipResult {
  const base: LLMRelationshipResult = {
    fileEdges: [],
    functionEdges: [],
    notes: [],
  };

  if (!payload || typeof payload !== 'object') {
    return base;
  }

  const working = payload as Record<string, unknown>;

  if (Array.isArray(working.notes)) {
    base.notes = working.notes.filter((note): note is string => typeof note === 'string');
  }

  if (Array.isArray(working.fileEdges)) {
    base.fileEdges = working.fileEdges
      .map((edge) => toFileEdge(edge))
      .filter((edge): edge is LLMRelationshipFileEdge => Boolean(edge));
  }

  if (Array.isArray(working.functionEdges)) {
    base.functionEdges = working.functionEdges
      .map((edge) => toFunctionEdge(edge))
      .filter((edge): edge is LLMRelationshipFunctionEdge => Boolean(edge));
  }

  return base;
}

function toFileEdge(raw: unknown): LLMRelationshipFileEdge | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const working = raw as Record<string, unknown>;

  if (typeof working.source !== 'string' || typeof working.target !== 'string') {
    return null;
  }

  return {
    source: working.source,
    target: working.target,
    relationship: typeof working.relationship === 'string' ? working.relationship : 'uses',
    confidence: typeof working.confidence === 'string' &&
               ['low', 'medium', 'high'].includes(working.confidence)
               ? working.confidence as RelationshipConfidence : undefined,
  };
}

function toFunctionEdge(raw: unknown): LLMRelationshipFunctionEdge | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const working = raw as Record<string, unknown>;

  if (!working.source || !working.target || typeof working.source !== 'object' || typeof working.target !== 'object') {
    return null;
  }

  const source = working.source as Record<string, unknown>;
  const target = working.target as Record<string, unknown>;

  if (typeof source.filePath !== 'string' || typeof source.symbol !== 'string' ||
      typeof target.filePath !== 'string' || typeof target.symbol !== 'string') {
    return null;
  }

  return {
    source: { filePath: source.filePath, symbol: source.symbol },
    target: { filePath: target.filePath, symbol: target.symbol },
    relationship: typeof working.relationship === 'string' ? working.relationship : 'calls',
    confidence: typeof working.confidence === 'string' &&
               ['low', 'medium', 'high'].includes(working.confidence)
               ? working.confidence as RelationshipConfidence : undefined,
    reason: typeof working.reason === 'string' ? working.reason : undefined,
  };
}
