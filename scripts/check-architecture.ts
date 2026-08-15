import { readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import ts from 'typescript';

type SourceArea =
  | { kind: 'app' | 'contracts' | 'core' | 'entrypoints' | 'integrations' | 'other' }
  | { kind: 'module'; feature: string };

export interface ArchitectureViolation {
  file: string;
  importedFile?: string;
  message: string;
}

const allowedFeatureDependencies: Readonly<Record<string, readonly string[]>> = {
  campaigns: ['gateway', 'group-lists', 'messages'],
  contacts: [],
  gateway: ['contacts'],
  'group-lists': ['gateway'],
  health: [],
  inbox: ['gateway'],
  messages: ['gateway'],
  orchestration: ['campaigns', 'contacts', 'gateway', 'messages', 'webhooks'],
  webhooks: ['contacts', 'gateway', 'messages'],
};

const sourceArea = (sourceRoot: string, file: string): SourceArea => {
  const parts = relative(sourceRoot, file).split(sep);
  if (parts[0] === 'modules' && parts[1]) return { kind: 'module', feature: parts[1] };
  if (parts[0] === 'app' || parts[0] === 'contracts' || parts[0] === 'core'
    || parts[0] === 'entrypoints' || parts[0] === 'integrations') {
    return { kind: parts[0] };
  }
  if (parts.length === 1 && parts[0] === 'app.module.ts') return { kind: 'app' };
  return { kind: 'other' };
};

const relativeImportTargets = (file: string): string[] => {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const targets: string[] = [];
  source.forEachChild(node => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
      && node.moduleSpecifier.text.startsWith('.')) {
      targets.push(resolve(file, '..', node.moduleSpecifier.text));
    }
  });
  return targets;
};

const permits = (source: SourceArea, target: SourceArea): boolean => {
  if (source.kind === 'core') return target.kind === 'core' || target.kind === 'contracts';
  if (source.kind === 'contracts') return target.kind === 'contracts';
  if (source.kind === 'integrations') return target.kind === 'integrations' || target.kind === 'core';
  if (source.kind === 'app') {
    return ['app', 'contracts', 'core', 'integrations', 'module'].includes(target.kind);
  }
  if (source.kind === 'entrypoints') {
    return target.kind === 'app' || target.kind === 'core'
      || (target.kind === 'module' && target.feature === 'orchestration');
  }
  if (source.kind === 'module') {
    if (target.kind === 'core' || target.kind === 'contracts' || target.kind === 'integrations') return true;
    if (target.kind !== 'module') return false;
    return source.feature === target.feature
      || (allowedFeatureDependencies[source.feature] ?? []).includes(target.feature);
  }
  return false;
};

const findFeatureCycles = (edges: ReadonlyMap<string, ReadonlySet<string>>): string[][] => {
  const cycles: string[][] = [];
  const visited = new Set<string>();
  const active = new Set<string>();
  const stack: string[] = [];

  const visit = (feature: string): void => {
    if (active.has(feature)) {
      const start = stack.indexOf(feature);
      cycles.push([...stack.slice(start), feature]);
      return;
    }
    if (visited.has(feature)) return;
    visited.add(feature);
    active.add(feature);
    stack.push(feature);
    for (const dependency of edges.get(feature) ?? []) visit(dependency);
    stack.pop();
    active.delete(feature);
  };

  for (const feature of [...edges.keys()].sort()) visit(feature);
  return cycles;
};

export function analyzeArchitecture(sourceRootInput: string): ArchitectureViolation[] {
  const sourceRoot = resolve(sourceRootInput);
  const files = ts.sys.readDirectory(sourceRoot, ['.ts'], undefined, undefined)
    .filter(file => !file.endsWith('.d.ts'))
    .sort();
  const violations: ArchitectureViolation[] = [];
  const featureEdges = new Map<string, Set<string>>();

  for (const file of files) {
    const source = sourceArea(sourceRoot, file);
    for (const targetFile of relativeImportTargets(file)) {
      if (!targetFile.startsWith(`${sourceRoot}${sep}`)) continue;
      const target = sourceArea(sourceRoot, targetFile);
      if (source.kind === 'module' && target.kind === 'module' && source.feature !== target.feature) {
        const dependencies = featureEdges.get(source.feature) ?? new Set<string>();
        dependencies.add(target.feature);
        featureEdges.set(source.feature, dependencies);
      }
      if (!permits(source, target)) {
        violations.push({
          file: relative(process.cwd(), file),
          importedFile: relative(process.cwd(), targetFile),
          message: `Forbidden dependency from ${source.kind}${source.kind === 'module' ? `:${source.feature}` : ''}`
            + ` to ${target.kind}${target.kind === 'module' ? `:${target.feature}` : ''}`,
        });
      }
    }
  }

  for (const cycle of findFeatureCycles(featureEdges)) {
    violations.push({
      file: 'src/modules',
      message: `Feature dependency cycle: ${cycle.join(' -> ')}`,
    });
  }
  return violations;
}

function main(): void {
  const violations = analyzeArchitecture(resolve(process.cwd(), 'src'));
  if (violations.length === 0) {
    console.log('Architecture boundaries are valid.');
    return;
  }
  for (const violation of violations) {
    console.error(`${violation.file}: ${violation.message}`
      + (violation.importedFile ? ` (${violation.importedFile})` : ''));
  }
  process.exitCode = 1;
}

if (require.main === module) main();
