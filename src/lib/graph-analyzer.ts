import path from 'path';
import { promises as fs } from 'fs';
import fg from 'fast-glob';
import { parse } from '@babel/parser';
import traverse, { type NodePath } from '@babel/traverse';
import * as t from '@babel/types';

import type {
  AnalyzeResponseBody,
  FileEdge,
  FileNode,
  FunctionEdge,
  FunctionNode,
  RelationshipConfidence,
} from './types';
import { RepoScannerError, resolveRepository } from './repo-scanner';
import { inferRelationshipsWithLLM, type LLMFileDigest } from './llm';

const SUPPORTED_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
const IMPORT_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json'];
const INDEX_FILES = IMPORT_EXTENSIONS.map((ext) => `/index${ext}`);
const IGNORED_DIRS = ['**/.git/**', '**/.next/**', '**/node_modules/**'];
const MAX_PREVIEW_CHARS = 4000;

interface ImportSpecifierBinding {
  local: string;
  imported: string;
  type: 'named' | 'default' | 'namespace';
  resolved?: string;
}

interface ImportBinding {
  source: string;
  resolved?: string;
  kind: 'es' | 'require' | 'dynamic';
  specifiers: ImportSpecifierBinding[];
}

interface FunctionInfo {
  id: string;
  name: string;
  filePath: string;
  kind: 'function' | 'arrow' | 'method' | 'class' | 'anonymous';
  loc?: {
    start: { line: number; column: number };
    end: { line: number; column: number };
  };
  exportName?: string;
  isExported: boolean;
  include: boolean;
}

interface CallBinding {
  local: string;
  imported: string;
  source: string;
  callerId: string;
  resolved?: string;
}

interface FileAnalysis {
  path: string;
  imports: ImportBinding[];
  functions: FunctionInfo[];
  calls: CallBinding[];
  preview: string;
  size: number;
}

interface FileEdgeRecord {
  source: string;
  target: string;
  kind: FileEdge['kind'];
  sourceType: 'static' | 'llm';
  confidence?: RelationshipConfidence;
  reason?: string;
}

interface FunctionEdgeRecord {
  source: string;
  target: string;
  kind: FunctionEdge['kind'];
  sourceType: 'static' | 'llm';
  confidence?: RelationshipConfidence;
  reason?: string;
}

interface AnalysisContext {
  root: string;
  files: Map<string, FileAnalysis>;
  warnings: string[];
  fileEdges: Map<string, FileEdgeRecord>;
  functionEdges: Map<string, FunctionEdgeRecord>;
  unresolved: Map<string, Set<string>>;
  exportedFunctions: Map<string, FunctionInfo>;
  resolver: (fromPath: string, specifier: string) => string | undefined;
}

interface TsconfigPathsEntry {
  prefix: string;
  suffix: string;
  targets: string[];
}

export async function analyzeRepositoryGraph(url: string): Promise<AnalyzeResponseBody> {
  const startedAt = Date.now();
  const repo = await resolveRepository(url);

  const fileEntries = await fg(['**/*'], {
    cwd: repo.path,
    dot: true,
    ignore: IGNORED_DIRS,
    onlyFiles: true,
    absolute: true,
  });

  const directoryEntries = await fg(['**/*'], {
    cwd: repo.path,
    dot: true,
    ignore: IGNORED_DIRS,
    onlyDirectories: true,
    absolute: true,
  });

  const files = fileEntries.map((abs) => ({
    abs,
    rel: normalizePath(repo.path, abs),
    ext: path.extname(abs).toLowerCase(),
  }));

  const directories = new Set(
    directoryEntries
      .map((abs) => {
        const rel = normalizePath(repo.path, abs);
        return rel === '' ? '.' : rel;
      })
      .concat(['.']),
  );

  if (!files.length) {
    throw new RepoScannerError('No files were found in the repository.');
  }

  const parseTargets = files.filter(({ ext }) => SUPPORTED_EXTENSIONS.includes(ext));
  const fileSet = new Set(files.map((file) => file.rel));
  const tsconfigPaths = await loadTsconfigPaths(repo.path);
  const resolver = createModuleResolver(fileSet, tsconfigPaths);

  const ctx: AnalysisContext = {
    root: repo.path,
    files: new Map(),
    warnings: repo.isRemote ? ['Repository cloned into local cache (.gitweb-cache/repos).'] : [],
    fileEdges: new Map(),
    functionEdges: new Map(),
    unresolved: new Map(),
    exportedFunctions: new Map(),
    resolver,
  };

  await Promise.all(
    parseTargets.map(async ({ abs, rel }) => {
      const analysis = await analyzeFile(abs, rel).catch((error) => {
        ctx.warnings.push(`Failed to analyze ${rel}: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      });

      if (analysis) {
        ctx.files.set(rel, analysis);
      }
    }),
  );

  if (!ctx.files.size) {
    ctx.warnings.push('No supported source files were parsed. File graph includes nodes without edges.');
  }

  resolveImports(ctx);
  collectFunctionExports(ctx);
  collectFunctionEdges(ctx);
  await enrichRelationshipsWithLLM(ctx);
  collectUnresolvedWarnings(ctx);

  const repoLabel = repo.displayName || path.basename(repo.path);
  const parsedFileNodes = new Set(Array.from(ctx.files.keys()));

  const directoryNodes: FileNode[] = Array.from(directories).map((relPath) => {
    const isRoot = relPath === '.' || relPath === '';
    const displayPath = isRoot ? '.' : relPath;
    const labelBase = isRoot ? repoLabel : path.posix.basename(relPath) || repoLabel;
    return {
      id: `dir:${displayPath}`,
      label: `${labelBase}/`,
      path: displayPath,
      kind: 'directory' as const,
    };
  });

  const fileNodes: FileNode[] = [
    ...directoryNodes,
    ...files
      .filter(({ rel }) => parsedFileNodes.has(rel))
      .map(({ rel }) => ({
        id: rel,
        label: path.posix.basename(rel) || repoLabel,
        path: rel,
        kind: 'file' as const,
      })),
  ];

  const fileEdges: FileEdge[] = Array.from(ctx.fileEdges.values()).map((edge) => ({
    id: `${edge.source}->${edge.target}`,
    source: edge.source,
    target: edge.target,
    kind: edge.kind,
    sourceType: edge.sourceType,
    confidence: edge.confidence,
    reason: edge.reason,
  }));

  const functionNodes: FunctionNode[] = [];
  const seenFunctionNodes = new Set<string>();
  for (const analysis of ctx.files.values()) {
    for (const fn of analysis.functions) {
      if (!fn.include) continue;
      if (seenFunctionNodes.has(fn.id)) continue;
      seenFunctionNodes.add(fn.id);
      functionNodes.push({
        id: fn.id,
        label: fn.exportName ?? fn.name,
        filePath: fn.filePath,
        kind: 'function',
        exportName: fn.exportName,
        loc: fn.loc,
      });
    }
  }

  const functionEdges: FunctionEdge[] = Array.from(ctx.functionEdges.values()).map((edge) => ({
    id: `${edge.source}->${edge.target}`,
    source: edge.source,
    target: edge.target,
    kind: edge.kind,
    sourceType: edge.sourceType,
    confidence: edge.confidence,
    reason: edge.reason,
  }));

  const response: AnalyzeResponseBody = {
    files: {
      nodes: fileNodes,
      edges: fileEdges,
    },
    functions: {
      nodes: functionNodes,
      edges: functionEdges,
    },
    warnings: ctx.warnings,
    stats: {
      fileCount: parsedFileNodes.size,
      directoryCount: directoryNodes.length,
      functionCount: functionNodes.length,
      durationMs: Date.now() - startedAt,
    },
    generatedAt: new Date().toISOString(),
  };

  return response;
}

async function analyzeFile(absPath: string, relPath: string): Promise<FileAnalysis> {
  const code = await fs.readFile(absPath, 'utf-8');
  const preview =
    code.length > MAX_PREVIEW_CHARS ? `${code.slice(0, MAX_PREVIEW_CHARS)}\n/* …preview truncated… */` : code;
  const ast = parse(code, {
    sourceType: 'unambiguous',
    plugins: [
      'typescript',
      'jsx',
      'classProperties',
      'classPrivateProperties',
      'classPrivateMethods',
      'dynamicImport',
      'topLevelAwait',
      'decorators-legacy',
    ],
  });

  const imports: ImportBinding[] = [];
  const functions: FunctionInfo[] = [];
  const calls: CallBinding[] = [];
  const importSpecifierLookup = new Map<string, ImportSpecifierBinding>();
  const functionNodeLookup = new WeakMap<t.Node, FunctionInfo>();
  let moduleInvoker: FunctionInfo | null = null;
  let functionCounter = 0;

  const ensureModuleInvoker = () => {
    if (!moduleInvoker) {
      moduleInvoker = {
        id: `${relPath}::(module)`,
        name: '(module)',
        filePath: relPath,
        kind: 'anonymous',
        isExported: false,
        include: true,
      } as FunctionInfo;
      functions.push(moduleInvoker);
    }
    return moduleInvoker;
  };

  const registerFunction = (
    node: t.Node,
    name: string,
    kind: FunctionInfo['kind'],
    exportName?: string,
    isExported = false,
    loc?: FunctionInfo['loc'],
  ): FunctionInfo => {
    const idBase = exportName ?? name ?? 'anonymous';
    const id = `${relPath}::${idBase || `fn_${functionCounter++}`}`;
    const info: FunctionInfo = {
      id,
      name: name || exportName || `anonymous_${functionCounter++}`,
      filePath: relPath,
      kind,
      exportName,
      isExported,
      include: isExported,
      loc,
    };
    functions.push(info);
    functionNodeLookup.set(node, info);
    return info;
  };

  const markExport = (info: FunctionInfo | undefined, exportName: string) => {
    if (!info) return;
    info.isExported = true;
    info.exportName = exportName;
    info.include = true;
  };

  traverse(ast, {
    ImportDeclaration(path) {
      const specifiers: ImportSpecifierBinding[] = [];
      path.node.specifiers.forEach((specifier) => {
        if (t.isImportSpecifier(specifier) && t.isIdentifier(specifier.local)) {
          const imported = t.isIdentifier(specifier.imported) ? specifier.imported.name : 'default';
          const record: ImportSpecifierBinding = {
            local: specifier.local.name,
            imported,
            type: 'named',
          };
          specifiers.push(record);
          importSpecifierLookup.set(record.local, record);
        } else if (t.isImportDefaultSpecifier(specifier)) {
          const record: ImportSpecifierBinding = {
            local: specifier.local.name,
            imported: 'default',
            type: 'default',
          };
          specifiers.push(record);
          importSpecifierLookup.set(record.local, record);
        } else if (t.isImportNamespaceSpecifier(specifier)) {
          const record: ImportSpecifierBinding = {
            local: specifier.local.name,
            imported: '*',
            type: 'namespace',
          };
          specifiers.push(record);
          importSpecifierLookup.set(record.local, record);
        }
      });
      imports.push({
        source: typeof path.node.source.value === 'string' ? path.node.source.value : '',
        kind: 'es',
        specifiers,
      });
    },
    CallExpression(path) {
      const callee = path.node.callee;
      if (!t.isIdentifier(callee)) {
        return;
      }
      const binding = path.scope.getBinding(callee.name);
      if (!binding || binding.kind !== 'module') {
        return;
      }
      const specifier = importSpecifierLookup.get(callee.name);
      if (!specifier || specifier.type === 'namespace') {
        return;
      }
      let importSource = '';
      const importParent = binding.path.parentPath;
      if (importParent && importParent.isImportDeclaration()) {
        importSource = typeof importParent.node.source.value === 'string' ? importParent.node.source.value : '';
      }
      const funcParent = path.getFunctionParent();
      let callerId: string;
      if (funcParent) {
        let registered = functionNodeLookup.get(funcParent.node);
        if (!registered) {
          const name = inferFunctionName(funcParent);
          registered = registerFunction(
            funcParent.node,
            name ?? `anonymous_${functionCounter++}`,
            inferFunctionKind(funcParent.node),
            undefined,
            false,
            funcParent.node.loc ?? undefined,
          );
        }
        registered.include = true;
        callerId = registered.id;
      } else {
        callerId = ensureModuleInvoker().id;
      }
      calls.push({
        local: specifier.local,
        imported: specifier.imported,
        source: importSource,
        callerId,
      });
    },
    FunctionDeclaration(path) {
      if (!path.node.id) {
        return;
      }
      const info = registerFunction(
        path.node,
        path.node.id.name,
        'function',
        undefined,
        path.parentPath.isExportNamedDeclaration(),
        path.node.loc ?? undefined,
      );
      if (path.parentPath.isExportNamedDeclaration()) {
        markExport(info, path.node.id.name);
      }
    },
    ArrowFunctionExpression(path) {
      const name = inferArrowFunctionName(path);
      const parentExport = path.findParent((parent) => parent.isExportNamedDeclaration() || parent.isExportDefaultDeclaration());
      const info = registerFunction(
        path.node,
        name ?? '',
        'arrow',
        parentExport?.isExportDefaultDeclaration() ? 'default' : undefined,
        parentExport ? true : false,
        path.node.loc ?? undefined,
      );
      if (parentExport?.isExportNamedDeclaration() && name) {
        markExport(info, name);
      }
      if (parentExport?.isExportDefaultDeclaration()) {
        markExport(info, 'default');
      }
    },
    FunctionExpression(path) {
      const name = inferFunctionName(path);
      const parentExport = path.findParent((parent) => parent.isExportDefaultDeclaration());
      const info = registerFunction(
        path.node,
        name ?? '',
        'function',
        parentExport ? 'default' : undefined,
        Boolean(parentExport),
        path.node.loc ?? undefined,
      );
      if (parentExport) {
        markExport(info, 'default');
      }
    },
    ClassMethod(path) {
      if (!t.isIdentifier(path.node.key)) {
        return;
      }
      const info = registerFunction(path.node, path.node.key.name, 'method', undefined, false, path.node.loc ?? undefined);
      const parentClass = path.findParent((parent) => parent.isClassDeclaration());
      if (
        parentClass?.isClassDeclaration() &&
        parentClass.node.id &&
        t.isIdentifier(parentClass.node.id) &&
        parentClass.parentPath?.isExportNamedDeclaration()
      ) {
        info.exportName = `${parentClass.node.id.name}.${path.node.key.name}`;
        info.include = true;
      }
    },
    ExportNamedDeclaration(path) {
      if (!path.node.declaration) {
        return;
      }
      const declaration = path.node.declaration;
      if (t.isFunctionDeclaration(declaration) && declaration.id) {
        const info = functionNodeLookup.get(declaration) ?? registerFunction(
          declaration,
          declaration.id.name,
          'function',
          declaration.id.name,
          true,
          declaration.loc ?? undefined,
        );
        markExport(info, declaration.id.name);
      }
      if (t.isVariableDeclaration(declaration)) {
        for (const decl of declaration.declarations) {
          if (t.isIdentifier(decl.id)) {
            const init = decl.init;
            if (init && (t.isFunctionExpression(init) || t.isArrowFunctionExpression(init))) {
              const info = functionNodeLookup.get(init) ?? registerFunction(
                init,
                decl.id.name,
                t.isArrowFunctionExpression(init) ? 'arrow' : 'function',
                decl.id.name,
                true,
                init.loc ?? undefined,
              );
              markExport(info, decl.id.name);
            }
          }
        }
      }
      if (t.isClassDeclaration(declaration) && declaration.id) {
        const info = registerFunction(
          declaration,
          declaration.id.name,
          'class',
          declaration.id.name,
          true,
          declaration.loc ?? undefined,
        );
        markExport(info, declaration.id.name);
      }
    },
    ExportDefaultDeclaration(path) {
      const declaration = path.node.declaration;
      if (t.isFunctionDeclaration(declaration)) {
        const name = declaration.id?.name ?? 'default';
        const info = functionNodeLookup.get(declaration) ?? registerFunction(
          declaration,
          name,
          'function',
          'default',
          true,
          declaration.loc ?? undefined,
        );
        markExport(info, 'default');
      } else if (t.isArrowFunctionExpression(declaration) || t.isFunctionExpression(declaration)) {
        const info = functionNodeLookup.get(declaration) ?? registerFunction(
          declaration,
          'default',
          t.isArrowFunctionExpression(declaration) ? 'arrow' : 'function',
          'default',
          true,
          declaration.loc ?? undefined,
        );
        markExport(info, 'default');
      } else if (t.isIdentifier(declaration)) {
        const binding = path.scope.getBinding(declaration.name);
        const info = binding?.path ? functionNodeLookup.get(binding.path.node) : undefined;
        markExport(info, 'default');
      }
    },
  });

  return {
    path: relPath,
    imports,
    functions,
    calls,
    preview,
    size: code.length,
  };
}

function resolveImports(ctx: AnalysisContext) {
  for (const [relPath, analysis] of ctx.files.entries()) {
    for (const binding of analysis.imports) {
      const resolved = ctx.resolver(relPath, binding.source);
      if (resolved) {
        binding.resolved = resolved;
        const edgeKey = `${relPath}->${resolved}`;
        const existing = ctx.fileEdges.get(edgeKey);
        ctx.fileEdges.set(edgeKey, {
          source: relPath,
          target: resolved,
          kind: existing?.kind ?? 'imports',
          sourceType: existing?.sourceType ?? 'static',
          confidence: existing?.confidence,
          reason: existing?.reason,
        });
        for (const spec of binding.specifiers) {
          spec.resolved = resolved;
        }
      } else if (binding.source) {
        const unresolved = ctx.unresolved.get(relPath) ?? new Set<string>();
        unresolved.add(binding.source);
        ctx.unresolved.set(relPath, unresolved);
      }
    }
  }
}

function collectFunctionExports(ctx: AnalysisContext) {
  for (const analysis of ctx.files.values()) {
    for (const fn of analysis.functions) {
      if (fn.isExported && fn.exportName) {
        ctx.exportedFunctions.set(`${analysis.path}:${fn.exportName}`, fn);
      }
    }
  }
}

function collectFunctionEdges(ctx: AnalysisContext) {
  for (const analysis of ctx.files.values()) {
    const specifierMap = new Map<string, ImportSpecifierBinding>();
    analysis.imports.forEach((binding) => {
      binding.specifiers.forEach((spec) => {
        specifierMap.set(spec.local, spec);
      });
    });

    for (const call of analysis.calls) {
      const spec = specifierMap.get(call.local);
      if (!spec || !spec.resolved) {
        continue;
      }
      const targetKey = `${spec.resolved}:${spec.imported}`;
      const targetFn = ctx.exportedFunctions.get(targetKey) ?? ctx.exportedFunctions.get(`${spec.resolved}:default`);
      if (!targetFn) {
        continue;
      }

      const caller = analysis.functions.find((fn) => fn.id === call.callerId);
      if (!caller) {
        continue;
      }
      caller.include = true;
      targetFn.include = true;
      call.resolved = spec.resolved;
      const edgeKey = `${caller.id}->${targetFn.id}`;
      const existing = ctx.functionEdges.get(edgeKey);
      ctx.functionEdges.set(edgeKey, {
        source: caller.id,
        target: targetFn.id,
        kind: existing?.kind ?? 'imports',
        sourceType: existing?.sourceType ?? 'static',
        confidence: existing?.confidence,
        reason: existing?.reason,
      });
    }
  }
}

async function enrichRelationshipsWithLLM(ctx: AnalysisContext): Promise<void> {
  try {
    const digests: LLMFileDigest[] = Array.from(ctx.files.values()).map((analysis) => ({
      filePath: analysis.path,
      size: analysis.size,
      preview: analysis.preview,
      imports: analysis.imports.map((binding) => ({
        specifier: binding.source,
        resolved: binding.resolved,
        kind: binding.kind,
        symbols: binding.specifiers.map((spec) => spec.imported),
      })),
      exports: analysis.functions
        .filter((fn) => fn.isExported)
        .map((fn) => ({
          name: fn.name,
          exportName: fn.exportName,
          kind: fn.kind,
          isExported: fn.isExported,
        })),
      calls: analysis.calls.map((call) => ({
        callerId: call.callerId,
        local: call.local,
        imported: call.imported,
        importPath: call.source,
        resolved: call.resolved,
      })),
    }));

    const result = await inferRelationshipsWithLLM(digests);
    if (!result) {
      if (!process.env.OPENAI_API_KEY) {
        ctx.warnings.push('Set OPENAI_API_KEY to enable LLM-inferred relationships.');
      }
      return;
    }

    const filePaths = new Set(ctx.files.keys());
    let llmFileEdges = 0;
    let llmFunctionEdges = 0;
    for (const edge of result.fileEdges ?? []) {
      if (!filePaths.has(edge.source) || !filePaths.has(edge.target)) {
        continue;
      }
      const key = `${edge.source}->${edge.target}`;
      const existing = ctx.fileEdges.get(key);
      const kind = edge.relationship.toLowerCase() === 'imports' ? 'imports' : 'llm-reference';
      if (existing) {
        if (!existing.confidence) {
          existing.confidence = edge.confidence;
        }
        // LLM edges don't have reason property, skip merging it
        continue;
      }
      ctx.fileEdges.set(key, {
        source: edge.source,
        target: edge.target,
        kind,
        sourceType: 'llm',
        confidence: edge.confidence,
        // LLM edges don't have reason property
      });
      llmFileEdges += 1;
    }

    const functionLookup = new Map<string, FunctionInfo>();
    for (const analysis of ctx.files.values()) {
      for (const fn of analysis.functions) {
        const identifiers = new Set<string>();
        identifiers.add(fn.id);
        if (fn.exportName) {
          identifiers.add(`${analysis.path}:${fn.exportName}`);
        }
        if (fn.name) {
          identifiers.add(`${analysis.path}:${fn.name}`);
        }
        identifiers.add(`${analysis.path}:${fn.exportName ?? fn.name}`);
        for (const key of identifiers) {
          functionLookup.set(key, fn);
        }
        if (fn.exportName && !functionLookup.has(fn.exportName)) {
          functionLookup.set(fn.exportName, fn);
        }
        if (fn.name && !functionLookup.has(fn.name)) {
          functionLookup.set(fn.name, fn);
        }
      }
    }

    for (const edge of result.functionEdges ?? []) {
      const sourceKey = `${edge.source.filePath}:${edge.source.symbol}`;
      const targetKey = `${edge.target.filePath}:${edge.target.symbol}`;
      const sourceFn = functionLookup.get(sourceKey);
      const targetFn = functionLookup.get(targetKey);
      if (!sourceFn || !targetFn) {
        continue;
      }
      sourceFn.include = true;
      targetFn.include = true;

      const key = `${sourceFn.id}->${targetFn.id}`;
      const relationship = edge.relationship.toLowerCase();
      const inferredKind: FunctionEdge['kind'] = relationship.includes('call') || relationship.includes('invoke')
        ? 'invokes'
        : 'llm-reference';
      const existing = ctx.functionEdges.get(key);
      if (existing) {
        if (!existing.confidence) {
          existing.confidence = edge.confidence;
        }
        if (edge.reason) {
          existing.reason = existing.reason ? `${existing.reason} ${edge.reason}` : edge.reason;
        }
        continue;
      }
      ctx.functionEdges.set(key, {
        source: sourceFn.id,
        target: targetFn.id,
        kind: inferredKind,
        sourceType: 'llm',
        confidence: edge.confidence,
        reason: edge.reason,
      });
      llmFunctionEdges += 1;
    }

    if (result.notes?.length) {
      for (const note of result.notes) {
        ctx.warnings.push(`LLM: ${note}`);
      }
    }
    if (llmFileEdges || llmFunctionEdges) {
      ctx.warnings.push(
        `LLM inferred ${llmFileEdges} file relationship${llmFileEdges === 1 ? '' : 's'} and ${llmFunctionEdges} function relationship${llmFunctionEdges === 1 ? '' : 's'}.`,
      );
    }
  } catch (error) {
    ctx.warnings.push(
      `LLM relationship inference failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function collectUnresolvedWarnings(ctx: AnalysisContext) {
  for (const [file, specifiers] of ctx.unresolved.entries()) {
    const items = Array.from(specifiers).slice(0, 5);
    const summary = items.join(', ');
    ctx.warnings.push(
      specifiers.size > 5
        ? `Some imports in ${file} could not be resolved: ${summary}, …`
        : `Could not resolve imports in ${file}: ${summary}`,
    );
  }
}

function createModuleResolver(fileSet: Set<string>, paths: TsconfigPathsEntry[]) {
  const candidateCache = new Map<string, string | undefined>();

  const tryCandidates = (base: string) => {
    const normBase = base.replace(/\\/g, '/');
    if (candidateCache.has(normBase)) {
      return candidateCache.get(normBase);
    }
    const candidates = [
      normBase,
      ...IMPORT_EXTENSIONS.map((ext) => `${normBase}${ext}`),
      ...INDEX_FILES.map((index) => `${normBase}${index}`),
    ];
    for (const candidate of candidates) {
      if (fileSet.has(candidate)) {
        candidateCache.set(normBase, candidate);
        return candidate;
      }
    }
    candidateCache.set(normBase, undefined);
    return undefined;
  };

  return (fromPath: string, specifier: string): string | undefined => {
    if (!specifier || typeof specifier !== 'string') {
      return undefined;
    }

    const fromDir = path.posix.dirname(fromPath);

    if (specifier.startsWith('.')) {
      const joined = path.posix.join(fromDir, specifier);
      return tryCandidates(path.posix.normalize(joined));
    }

    for (const entry of paths) {
      if (!specifier.startsWith(entry.prefix)) {
        continue;
      }
      const remainder = specifier.slice(entry.prefix.length, entry.prefix.length === specifier.length ? undefined : specifier.length - entry.suffix.length);
      for (const target of entry.targets) {
        const candidate = path.posix.join(target, remainder ?? '');
        const resolved = tryCandidates(path.posix.normalize(candidate));
        if (resolved) {
          return resolved;
        }
      }
    }

    // absolute from project root
    const absoluteCandidate = tryCandidates(path.posix.join('.', specifier));
    if (absoluteCandidate) {
      return absoluteCandidate;
    }

    // support src-relative imports (Next.js common pattern)
    const srcCandidate = tryCandidates(path.posix.join('src', specifier));
    if (srcCandidate) {
      return srcCandidate;
    }

    return undefined;
  };
}

async function loadTsconfigPaths(root: string): Promise<TsconfigPathsEntry[]> {
  const files = ['tsconfig.json', 'jsconfig.json'];
  for (const configFile of files) {
    const abs = path.join(root, configFile);
    try {
      const raw = await fs.readFile(abs, 'utf-8');
      const json = JSON.parse(stripJsonComments(raw));
      const compilerOptions = json?.compilerOptions;
      if (!compilerOptions || !compilerOptions.paths) {
        continue;
      }
      const entries: TsconfigPathsEntry[] = [];
      for (const [key, values] of Object.entries<Record<string, string[]>>(compilerOptions.paths)) {
        if (!Array.isArray(values) || !values.length) {
          continue;
        }
        const starIndex = key.indexOf('*');
        const prefix = starIndex >= 0 ? key.slice(0, starIndex) : key;
        const suffix = starIndex >= 0 ? key.slice(starIndex + 1) : '';
        const targets = values.map((value) => {
          const targetStar = value.indexOf('*');
          const targetPrefix = targetStar >= 0 ? value.slice(0, targetStar) : value;
          return path.posix.normalize(targetPrefix.replace(/^\.?\//, ''));
        });
        entries.push({ prefix, suffix, targets });
      }
      return entries;
    } catch {
      continue;
    }
  }
  return [];
}

function stripJsonComments(input: string): string {
  return input
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/([^:]|^)(\/\/.*)$/gm, '$1');
}

function inferArrowFunctionName(path: NodePath<t.ArrowFunctionExpression>): string | undefined {
  if (path.parentPath.isVariableDeclarator() && t.isIdentifier(path.parentPath.node.id)) {
    return path.parentPath.node.id.name;
  }
  if (path.parentPath.isAssignmentExpression()) {
    const left = path.parentPath.node.left;
    if (t.isIdentifier(left)) {
      return left.name;
    }
  }
  return undefined;
}

function inferFunctionName(path: NodePath<t.Function | t.FunctionExpression | t.FunctionDeclaration>): string | undefined {
  if (path.isFunctionDeclaration() && path.node.id) {
    return path.node.id.name;
  }
  if (path.isFunctionExpression() && path.node.id) {
    return path.node.id.name;
  }
  if (path.parentPath.isVariableDeclarator() && t.isIdentifier(path.parentPath.node.id)) {
    return path.parentPath.node.id.name;
  }
  if (path.parentPath.isAssignmentExpression()) {
    const left = path.parentPath.node.left;
    if (t.isIdentifier(left)) {
      return left.name;
    }
  }
  return undefined;
}

function inferFunctionKind(node: t.Node): FunctionInfo['kind'] {
  if (t.isArrowFunctionExpression(node)) return 'arrow';
  if (t.isClassMethod(node) || t.isObjectMethod?.(node)) return 'method';
  if (t.isClassDeclaration(node)) return 'class';
  return 'function';
}

function normalizePath(root: string, absolutePath: string): string {
  return path.relative(root, absolutePath).split(path.sep).join('/') || '.';
}








