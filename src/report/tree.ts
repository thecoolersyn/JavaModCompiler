export interface GraphNode {
  id: string;
  label: string;
  detail?: string;
  status?: 'ok' | 'missing' | 'conflict';
  children: GraphNode[];
}

export function renderTree(nodes: GraphNode[], options: { missingFirst?: boolean } = {}): string[] {
  const lines: string[] = [];
  const ordered = options.missingFirst === true ? [...nodes].sort(sortMissingFirst) : nodes;
  ordered.forEach((node, index) => {
    const isLast = index === ordered.length - 1;
    const connector = isLast ? '└─ ' : '├─ ';
    lines.push(`${connector}${renderNode(node)}`);
    if (node.children.length > 0) {
      const childLines = renderTree(node.children, options);
      for (const childLine of childLines) {
        lines.push(isLast ? `   ${childLine}` : `│  ${childLine}`);
      }
    }
  });
  return lines;
}

function sortMissingFirst(a: GraphNode, b: GraphNode): number {
  const rank = (node: GraphNode): number => (node.status === 'missing' ? 0 : node.status === 'conflict' ? 1 : 2);
  const difference = rank(a) - rank(b);
  if (difference !== 0) return difference;
  return a.label.localeCompare(b.label);
}

function renderNode(node: GraphNode): string {
  const suffix = node.detail !== undefined && node.detail.length > 0 ? ` ${node.detail}` : '';
  if (node.status === 'missing') return `${node.label} (UNRESOLVED)${suffix}`;
  if (node.status === 'conflict') return `${node.label} (VERSION CONFLICT)${suffix}`;
  return `${node.label}${suffix}`;
}

export function renderKeyValues(entries: Array<[string, string | undefined]>, options: { indent?: string; skipUndefined?: boolean } = {}): string[] {
  const indent = options.indent ?? '';
  const lines: string[] = [];
  for (const [key, value] of entries) {
    if (value === undefined && options.skipUndefined !== false) continue;
    lines.push(`${indent}${key}: ${value ?? 'not detected'}`);
  }
  return lines;
}

export function heading(text: string): string {
  return text;
}

export function bulletList(items: string[], indent = '  '): string[] {
  return items.map((item) => `${indent}- ${item}`);
}