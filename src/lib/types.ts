export interface AnalyzeRequestBody {
  url: string;
}

export interface FileNode {
  id: string;
  label: string;
  path: string;
  kind?: 'file' | 'directory';
}

export type RelationshipConfidence = 'low' | 'medium' | 'high';

export interface FileEdge {
  id: string;
  source: string;
  target: string;
  kind: 'imports' | 'llm-reference';
  sourceType: 'static' | 'llm';
  confidence?: RelationshipConfidence;
  reason?: string;
}

export interface FunctionNode {
  id: string;
  label: string;
  filePath: string;
  kind: 'function';
  exportName?: string;
  loc?: {
    start: { line: number; column: number };
    end: { line: number; column: number };
  };
}

export interface FunctionEdge {
  id: string;
  source: string;
  target: string;
  kind: 'imports' | 'reexports' | 'invokes' | 'llm-reference';
  sourceType: 'static' | 'llm';
  confidence?: RelationshipConfidence;
  reason?: string;
}

export interface GraphView<TNode, TEdge> {
  nodes: TNode[];
  edges: TEdge[];
}

export interface AnalyzeResponseBody {
  files: GraphView<FileNode, FileEdge>;
  functions: GraphView<FunctionNode, FunctionEdge>;
  warnings: string[];
  stats: {
    fileCount: number;
    directoryCount: number;
    functionCount: number;
    durationMs: number;
  };
  generatedAt: string;
}
