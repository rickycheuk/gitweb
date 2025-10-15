import * as parser from '@babel/parser';
import traverse from '@babel/traverse';
import { ClassBody } from '@babel/types';
import path from 'path';

export interface FunctionInfo {
  name: string;
  type: 'function' | 'class' | 'method';
  calls: string[];
}

export interface ParseResult {
  imports: string[];
  functions: FunctionInfo[];
}

export function parseCodeFile(content: string, filePath: string): ParseResult {
  const ext = path.extname(filePath).toLowerCase();
  
  if (['.ts', '.tsx', '.js', '.jsx'].includes(ext)) {
    return parseJavaScriptTypeScript(content);
  } else if (ext === '.py') {
    return parsePython(content);
  } else if (ext === '.go') {
    return parseGo(content);
  } else if (ext === '.rs') {
    return parseRust(content);
  } else if (ext === '.java') {
    return parseJava(content);
  } else if (['.c', '.cpp', '.cc', '.cxx', '.h', '.hpp'].includes(ext)) {
    return parseCCpp(content);
  } else if (ext === '.rb') {
    return parseRuby(content);
  } else if (ext === '.php') {
    return parsePHP(content);
  } else if (ext === '.swift') {
    return parseSwift(content);
  } else if (['.kt', '.kts'].includes(ext)) {
    return parseKotlin(content);
  } else if (ext === '.cs') {
    return parseCSharp(content);
  } else if (ext === '.scala') {
    return parseScala(content);
  } else if (ext === '.dart') {
    return parseDart(content);
  } else if (ext === '.r') {
    return parseR(content);
  } else if (ext === '.jl') {
    return parseJulia(content);
  } else if (ext === '.lua') {
    return parseLua(content);
  } else if (['.sh', '.bash', '.zsh'].includes(ext)) {
    return parseShell(content);
  }
  
  return { imports: [], functions: [] };
}

function parseJavaScriptTypeScript(content: string): ParseResult {
  const imports: string[] = [];
  const functions: FunctionInfo[] = [];
  
  try {
    const ast = parser.parse(content, {
      sourceType: 'module',
      plugins: [
        'jsx',
        'typescript',
        'decorators-legacy',
        'classProperties',
        'dynamicImport',
      ],
    });

    traverse(ast, {
      ImportDeclaration(path) {
        imports.push(path.node.source.value);
      },
      
      CallExpression(path) {
        // Track function calls for relationship analysis
        if (path.node.callee.type === 'Identifier') {
          // Simple function call like: myFunction()
          // We'll track these in the function analysis below
        }
      },

      FunctionDeclaration(path) {
        if (path.node.id) {
          const calls: string[] = [];
          
          // Extract function calls within this function
          path.traverse({
            CallExpression(callPath) {
              if (callPath.node.callee.type === 'Identifier') {
                calls.push(callPath.node.callee.name);
              } else if (
                callPath.node.callee.type === 'MemberExpression' &&
                callPath.node.callee.property.type === 'Identifier'
              ) {
                calls.push(callPath.node.callee.property.name);
              }
            },
          });

          functions.push({
            name: path.node.id.name,
            type: 'function',
            calls,
          });
        }
      },

      ArrowFunctionExpression(path) {
        if (
          path.parent.type === 'VariableDeclarator' &&
          path.parent.id.type === 'Identifier'
        ) {
          const calls: string[] = [];
          
          path.traverse({
            CallExpression(callPath) {
              if (callPath.node.callee.type === 'Identifier') {
                calls.push(callPath.node.callee.name);
              } else if (
                callPath.node.callee.type === 'MemberExpression' &&
                callPath.node.callee.property.type === 'Identifier'
              ) {
                calls.push(callPath.node.callee.property.name);
              }
            },
          });

          functions.push({
            name: path.parent.id.name,
            type: 'function',
            calls,
          });
        }
      },

      ClassDeclaration(path) {
        if (path.node.id) {
          functions.push({
            name: path.node.id.name,
            type: 'class',
            calls: [],
          });

          // Add methods
          (path.node.body.body as ClassBody['body']).forEach((member) => {
            if (
              member.type === 'ClassMethod' &&
              member.key.type === 'Identifier'
            ) {
              const calls: string[] = [];
              
              traverse(
                member,
                {
                  CallExpression(callPath) {
                    if (callPath.node.callee.type === 'Identifier') {
                      calls.push(callPath.node.callee.name);
                    } else if (
                      callPath.node.callee.type === 'MemberExpression' &&
                      callPath.node.callee.property.type === 'Identifier'
                    ) {
                      calls.push(callPath.node.callee.property.name);
                    }
                  },
                },
                path.scope,
                path
              );

              functions.push({
                name: `${path.node.id!.name}.${member.key.name}`,
                type: 'method',
                calls,
              });
            }
          });
        }
      },
    });
  } catch (error) {
    console.error('Parse error:', error);
  }

  return { imports, functions };
}

function parsePython(content: string): ParseResult {
  const imports: string[] = [];
  const functions: FunctionInfo[] = [];

  // Simple regex-based parsing for Python
  const importRegex = /^(?:from\s+([^\s]+)\s+)?import\s+(.+)$/gm;
  const functionRegex = /^def\s+(\w+)\s*\(/gm;
  const classRegex = /^class\s+(\w+).*:/gm;

  let match;

  // Extract imports
  while ((match = importRegex.exec(content)) !== null) {
    if (match[1]) {
      imports.push(match[1]);
    }
  }

  // Extract functions
  while ((match = functionRegex.exec(content)) !== null) {
    functions.push({
      name: match[1],
      type: 'function',
      calls: extractPythonCalls(content, match.index),
    });
  }

  // Extract classes
  while ((match = classRegex.exec(content)) !== null) {
    functions.push({
      name: match[1],
      type: 'class',
      calls: [],
    });
  }

  return { imports, functions };
}

function extractPythonCalls(content: string, startIndex: number): string[] {
  const calls: string[] = [];
  const lines = content.slice(startIndex).split('\n');
  const callRegex = /(\w+)\s*\(/g;

  // Extract from the next 50 lines or until next function
  for (let i = 1; i < Math.min(lines.length, 50); i++) {
    const line = lines[i];
    if (line.match(/^def\s+/) || line.match(/^class\s+/)) break;

    let match;
    while ((match = callRegex.exec(line)) !== null) {
      calls.push(match[1]);
    }
  }

  return [...new Set(calls)];
}

function parseGo(content: string): ParseResult {
  const imports: string[] = [];
  const functions: FunctionInfo[] = [];

  const importRegex = /import\s+(?:"([^"]+)"|(\([^)]+\)))/g;
  const funcRegex = /func\s+(?:\([^)]*\)\s+)?(\w+)\s*\(/g;
  const structRegex = /type\s+(\w+)\s+struct/g;

  let match;

  while ((match = importRegex.exec(content)) !== null) {
    if (match[1]) imports.push(match[1]);
  }

  while ((match = funcRegex.exec(content)) !== null) {
    functions.push({ name: match[1], type: 'function', calls: [] });
  }

  while ((match = structRegex.exec(content)) !== null) {
    functions.push({ name: match[1], type: 'class', calls: [] });
  }

  return { imports, functions };
}

function parseRust(content: string): ParseResult {
  const imports: string[] = [];
  const functions: FunctionInfo[] = [];

  const useRegex = /use\s+([^;]+);/g;
  const fnRegex = /(?:pub\s+)?fn\s+(\w+)/g;
  const structRegex = /(?:pub\s+)?struct\s+(\w+)/g;

  let match;

  while ((match = useRegex.exec(content)) !== null) {
    imports.push(match[1].split('::')[0]);
  }

  while ((match = fnRegex.exec(content)) !== null) {
    functions.push({ name: match[1], type: 'function', calls: [] });
  }

  while ((match = structRegex.exec(content)) !== null) {
    functions.push({ name: match[1], type: 'class', calls: [] });
  }

  return { imports, functions };
}

function parseJava(content: string): ParseResult {
  const imports: string[] = [];
  const functions: FunctionInfo[] = [];

  const importRegex = /import\s+(?:static\s+)?([^;]+);/g;
  const classRegex = /(?:public|private|protected)?\s*(?:static\s+)?class\s+(\w+)/g;
  const methodRegex = /(?:public|private|protected)?\s*(?:static\s+)?(?:\w+\s+)+(\w+)\s*\([^)]*\)\s*(?:throws\s+[^{]+)?\s*{/g;

  let match;

  while ((match = importRegex.exec(content)) !== null) {
    const parts = match[1].split('.');
    imports.push(parts[parts.length - 1]);
  }

  while ((match = classRegex.exec(content)) !== null) {
    functions.push({ name: match[1], type: 'class', calls: [] });
  }

  while ((match = methodRegex.exec(content)) !== null) {
    functions.push({ name: match[1], type: 'method', calls: [] });
  }

  return { imports, functions };
}

function parseCCpp(content: string): ParseResult {
  const imports: string[] = [];
  const functions: FunctionInfo[] = [];

  const includeRegex = /#include\s+[<"]([^>"]+)[>"]/g;
  const funcRegex = /(?:\w+\s+)+(\w+)\s*\([^)]*\)\s*{/g;
  const classRegex = /class\s+(\w+)/g;
  const structRegex = /struct\s+(\w+)/g;

  let match;

  while ((match = includeRegex.exec(content)) !== null) {
    imports.push(match[1]);
  }

  while ((match = funcRegex.exec(content)) !== null) {
    if (!['if', 'for', 'while', 'switch'].includes(match[1])) {
      functions.push({ name: match[1], type: 'function', calls: [] });
    }
  }

  while ((match = classRegex.exec(content)) !== null) {
    functions.push({ name: match[1], type: 'class', calls: [] });
  }

  while ((match = structRegex.exec(content)) !== null) {
    functions.push({ name: match[1], type: 'class', calls: [] });
  }

  return { imports, functions };
}

function parseRuby(content: string): ParseResult {
  const imports: string[] = [];
  const functions: FunctionInfo[] = [];

  const requireRegex = /require\s+['"]([^'"]+)['"]/g;
  const defRegex = /def\s+(?:self\.)?(\w+)/g;
  const classRegex = /class\s+(\w+)/g;
  const moduleRegex = /module\s+(\w+)/g;

  let match;

  while ((match = requireRegex.exec(content)) !== null) {
    imports.push(match[1]);
  }

  while ((match = defRegex.exec(content)) !== null) {
    functions.push({ name: match[1], type: 'function', calls: [] });
  }

  while ((match = classRegex.exec(content)) !== null) {
    functions.push({ name: match[1], type: 'class', calls: [] });
  }

  while ((match = moduleRegex.exec(content)) !== null) {
    functions.push({ name: match[1], type: 'class', calls: [] });
  }

  return { imports, functions };
}

function parsePHP(content: string): ParseResult {
  const imports: string[] = [];
  const functions: FunctionInfo[] = [];

  const useRegex = /use\s+([^;]+);/g;
  const requireRegex = /require(?:_once)?\s+['"]([^'"]+)['"]/g;
  const functionRegex = /function\s+(\w+)\s*\(/g;
  const classRegex = /class\s+(\w+)/g;

  let match;

  while ((match = useRegex.exec(content)) !== null) {
    const parts = match[1].split('\\');
    imports.push(parts[parts.length - 1]);
  }

  while ((match = requireRegex.exec(content)) !== null) {
    imports.push(match[1]);
  }

  while ((match = functionRegex.exec(content)) !== null) {
    functions.push({ name: match[1], type: 'function', calls: [] });
  }

  while ((match = classRegex.exec(content)) !== null) {
    functions.push({ name: match[1], type: 'class', calls: [] });
  }

  return { imports, functions };
}

function parseSwift(content: string): ParseResult {
  const imports: string[] = [];
  const functions: FunctionInfo[] = [];

  const importRegex = /import\s+(\w+)/g;
  const funcRegex = /func\s+(\w+)/g;
  const classRegex = /class\s+(\w+)/g;
  const structRegex = /struct\s+(\w+)/g;

  let match;

  while ((match = importRegex.exec(content)) !== null) {
    imports.push(match[1]);
  }

  while ((match = funcRegex.exec(content)) !== null) {
    functions.push({ name: match[1], type: 'function', calls: [] });
  }

  while ((match = classRegex.exec(content)) !== null) {
    functions.push({ name: match[1], type: 'class', calls: [] });
  }

  while ((match = structRegex.exec(content)) !== null) {
    functions.push({ name: match[1], type: 'class', calls: [] });
  }

  return { imports, functions };
}

function parseKotlin(content: string): ParseResult {
  const imports: string[] = [];
  const functions: FunctionInfo[] = [];

  const importRegex = /import\s+([^\s]+)/g;
  const funRegex = /fun\s+(\w+)/g;
  const classRegex = /class\s+(\w+)/g;
  const objectRegex = /object\s+(\w+)/g;

  let match;

  while ((match = importRegex.exec(content)) !== null) {
    const parts = match[1].split('.');
    imports.push(parts[parts.length - 1]);
  }

  while ((match = funRegex.exec(content)) !== null) {
    functions.push({ name: match[1], type: 'function', calls: [] });
  }

  while ((match = classRegex.exec(content)) !== null) {
    functions.push({ name: match[1], type: 'class', calls: [] });
  }

  while ((match = objectRegex.exec(content)) !== null) {
    functions.push({ name: match[1], type: 'class', calls: [] });
  }

  return { imports, functions };
}

function parseCSharp(content: string): ParseResult {
  const imports: string[] = [];
  const functions: FunctionInfo[] = [];

  const usingRegex = /using\s+([^;]+);/g;
  const classRegex = /(?:public|private|protected|internal)?\s*(?:static\s+)?class\s+(\w+)/g;
  const methodRegex = /(?:public|private|protected|internal)?\s*(?:static\s+)?(?:async\s+)?(?:\w+\s+)+(\w+)\s*\([^)]*\)/g;

  let match;

  while ((match = usingRegex.exec(content)) !== null) {
    const parts = match[1].split('.');
    imports.push(parts[parts.length - 1]);
  }

  while ((match = classRegex.exec(content)) !== null) {
    functions.push({ name: match[1], type: 'class', calls: [] });
  }

  while ((match = methodRegex.exec(content)) !== null) {
    if (!['if', 'for', 'while', 'foreach', 'switch', 'using', 'lock'].includes(match[1])) {
      functions.push({ name: match[1], type: 'method', calls: [] });
    }
  }

  return { imports, functions };
}

function parseScala(content: string): ParseResult {
  const imports: string[] = [];
  const functions: FunctionInfo[] = [];

  const importRegex = /import\s+([^\s]+)/g;
  const defRegex = /def\s+(\w+)/g;
  const classRegex = /class\s+(\w+)/g;
  const objectRegex = /object\s+(\w+)/g;

  let match;

  while ((match = importRegex.exec(content)) !== null) {
    imports.push(match[1]);
  }

  while ((match = defRegex.exec(content)) !== null) {
    functions.push({ name: match[1], type: 'function', calls: [] });
  }

  while ((match = classRegex.exec(content)) !== null) {
    functions.push({ name: match[1], type: 'class', calls: [] });
  }

  while ((match = objectRegex.exec(content)) !== null) {
    functions.push({ name: match[1], type: 'class', calls: [] });
  }

  return { imports, functions };
}

function parseDart(content: string): ParseResult {
  const imports: string[] = [];
  const functions: FunctionInfo[] = [];

  const importRegex = /import\s+['"]([^'"]+)['"]/g;
  const functionRegex = /(?:\w+\s+)?(\w+)\s*\([^)]*\)\s*(?:async\s*)?{/g;
  const classRegex = /class\s+(\w+)/g;

  let match;

  while ((match = importRegex.exec(content)) !== null) {
    imports.push(match[1]);
  }

  while ((match = functionRegex.exec(content)) !== null) {
    if (!['if', 'for', 'while', 'switch'].includes(match[1])) {
      functions.push({ name: match[1], type: 'function', calls: [] });
    }
  }

  while ((match = classRegex.exec(content)) !== null) {
    functions.push({ name: match[1], type: 'class', calls: [] });
  }

  return { imports, functions };
}

function parseR(content: string): ParseResult {
  const imports: string[] = [];
  const functions: FunctionInfo[] = [];

  const libraryRegex = /library\((\w+)\)/g;
  const sourceRegex = /source\(['"]([^'"]+)['"]\)/g;
  const functionRegex = /(\w+)\s*<-\s*function\s*\(/g;

  let match;

  while ((match = libraryRegex.exec(content)) !== null) {
    imports.push(match[1]);
  }

  while ((match = sourceRegex.exec(content)) !== null) {
    imports.push(match[1]);
  }

  while ((match = functionRegex.exec(content)) !== null) {
    functions.push({ name: match[1], type: 'function', calls: [] });
  }

  return { imports, functions };
}

function parseJulia(content: string): ParseResult {
  const imports: string[] = [];
  const functions: FunctionInfo[] = [];

  const usingRegex = /using\s+(\w+)/g;
  const importRegex = /import\s+([^\s]+)/g;
  const functionRegex = /function\s+(\w+)/g;
  const structRegex = /struct\s+(\w+)/g;

  let match;

  while ((match = usingRegex.exec(content)) !== null) {
    imports.push(match[1]);
  }

  while ((match = importRegex.exec(content)) !== null) {
    imports.push(match[1]);
  }

  while ((match = functionRegex.exec(content)) !== null) {
    functions.push({ name: match[1], type: 'function', calls: [] });
  }

  while ((match = structRegex.exec(content)) !== null) {
    functions.push({ name: match[1], type: 'class', calls: [] });
  }

  return { imports, functions };
}

function parseLua(content: string): ParseResult {
  const imports: string[] = [];
  const functions: FunctionInfo[] = [];

  const requireRegex = /require\s*\(?['"]([^'"]+)['"]\)?/g;
  const functionRegex = /function\s+(?:(\w+)\.)?(\w+)\s*\(/g;
  const localFunctionRegex = /local\s+function\s+(\w+)/g;

  let match;

  while ((match = requireRegex.exec(content)) !== null) {
    imports.push(match[1]);
  }

  while ((match = functionRegex.exec(content)) !== null) {
    const name = match[1] ? `${match[1]}.${match[2]}` : match[2];
    functions.push({ name, type: 'function', calls: [] });
  }

  while ((match = localFunctionRegex.exec(content)) !== null) {
    functions.push({ name: match[1], type: 'function', calls: [] });
  }

  return { imports, functions };
}

function parseShell(content: string): ParseResult {
  const imports: string[] = [];
  const functions: FunctionInfo[] = [];

  const sourceRegex = /(?:source|\.) \s*['"]?([^'";\s]+)['"]?/g;
  const functionRegex = /(?:function\s+)?(\w+)\s*\(\)\s*{/g;

  let match;

  while ((match = sourceRegex.exec(content)) !== null) {
    imports.push(match[1]);
  }

  while ((match = functionRegex.exec(content)) !== null) {
    functions.push({ name: match[1], type: 'function', calls: [] });
  }

  return { imports, functions };
}
