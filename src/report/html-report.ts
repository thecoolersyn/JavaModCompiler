import fs from 'node:fs';
import path from 'node:path';
import type { BuildReport } from './build-report.js';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function statusClass(status: string): string {
  switch (status) {
    case 'pass':
      return 'pass';
    case 'failed':
      return 'failed';
    case 'warning':
      return 'warning';
    case 'skipped':
      return 'skipped';
    case 'running':
      return 'running';
    default:
      return 'info';
  }
}

function renderDiagnostics(report: BuildReport): string {
  if (report.diagnostics.length === 0) return '<p class="empty">No diagnostics were recorded.</p>';
  const items = report.diagnostics
    .map((diagnostic) => {
      const parts: string[] = [];
      parts.push(`<div class="diagnostic ${escapeHtml(diagnostic.severity)}">`);
      parts.push(`<h3>${escapeHtml(diagnostic.title)}</h3>`);
      parts.push(`<p>${escapeHtml(diagnostic.summary)}</p>`);
      if (diagnostic.detected !== undefined && diagnostic.detected.length > 0) {
        parts.push('<h4>Detected</h4><ul>');
        for (const item of diagnostic.detected) parts.push(`<li>${escapeHtml(item)}</li>`);
        parts.push('</ul>');
      }
      if (diagnostic.expected !== undefined) parts.push(`<p><strong>Expected:</strong> ${escapeHtml(diagnostic.expected)}</p>`);
      if (diagnostic.cause !== undefined) parts.push(`<p><strong>Cause:</strong> ${escapeHtml(diagnostic.cause)}</p>`);
      if (diagnostic.suggestions.length > 0) {
        parts.push('<h4>Suggested action</h4><ul>');
        for (const suggestion of diagnostic.suggestions) parts.push(`<li>${escapeHtml(suggestion)}</li>`);
        parts.push('</ul>');
      }
      if (diagnostic.evidence.length > 0) {
        parts.push('<details><summary>Evidence</summary><ul>');
        for (const item of diagnostic.evidence) parts.push(`<li><code>${escapeHtml(item)}</code></li>`);
        parts.push('</ul></details>');
      }
      parts.push('</div>');
      return parts.join('');
    })
    .join('');
  return items;
}

function renderStages(report: BuildReport): string {
  return report.stages
    .map((stage) => {
      const artifacts =
        stage.artifacts.length === 0
          ? ''
          : `<details><summary>Artifacts (${stage.artifacts.length})</summary><ul>${stage.artifacts
              .map((artifact) => `<li><code>${escapeHtml(artifact)}</code></li>`)
              .join('')}</ul></details>`;
      const messages =
        stage.messages.length === 0
          ? ''
          : `<ul>${stage.messages.map((message) => `<li>${escapeHtml(message)}</li>`).join('')}</ul>`;
      return `<tr class="${statusClass(stage.status)}"><td>${escapeHtml(stage.id)}</td><td>${escapeHtml(stage.label)}</td><td><span class="badge ${statusClass(stage.status)}">${escapeHtml(stage.status)}</span></td><td>${stage.durationMs} ms</td><td>${messages}${artifacts}</td></tr>`;
    })
    .join('');
}

function renderDependencyNodes(nodes: BuildReport['dependencies']['graph']): string {
  if (nodes.length === 0) return '<tr><td colspan="4" class="empty">No dependencies were resolved.</td></tr>';
  const rows: string[] = [];
  const walk = (list: BuildReport['dependencies']['graph'], depth: number): void => {
    for (const node of list) {
      const indent = '&nbsp;'.repeat(depth * 4);
      rows.push(
        `<tr><td>${indent}${escapeHtml(node.coordinate.groupId)}</td><td>${escapeHtml(node.coordinate.artifactId)}</td><td>${escapeHtml(node.coordinate.version)}</td><td>${escapeHtml(node.status)}${node.repositoryId === undefined ? '' : ` (${escapeHtml(node.repositoryId)})`}</td></tr>`,
      );
      walk(node.children, depth + 1);
    }
  };
  walk(nodes, 0);
  return rows.join('');
}

export function renderBuildReportHtml(report: BuildReport): string {
  const outcome = report.status.toUpperCase();
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>JMC build report ${escapeHtml(report.buildId)}</title>
<style>
:root { color-scheme: light dark; }
body { font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0; padding: 2rem; line-height: 1.5; }
h1 { margin-top: 0; font-size: 1.6rem; }
h2 { margin-top: 2rem; font-size: 1.2rem; border-bottom: 1px solid rgba(128,128,128,0.3); padding-bottom: 0.3rem; }
table { border-collapse: collapse; width: 100%; margin: 1rem 0; font-size: 0.9rem; }
th, td { border: 1px solid rgba(128,128,128,0.3); padding: 0.4rem 0.6rem; text-align: left; vertical-align: top; }
th { background: rgba(128,128,128,0.12); font-weight: 600; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.85rem; }
.badge { display: inline-block; padding: 0.1rem 0.5rem; border-radius: 0.25rem; font-size: 0.8rem; font-weight: 600; }
.badge.pass { background: #1f8b4c33; color: #1f8b4c; }
.badge.failed { background: #c0262633; color: #c02626; }
.badge.warning { background: #b8860b33; color: #b8860b; }
.badge.skipped, .badge.running { background: #6b728033; color: #6b7280; }
.badge.info { background: #2563eb33; color: #2563eb; }
.summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 0.75rem; margin: 1rem 0; }
.summary div { border: 1px solid rgba(128,128,128,0.3); border-radius: 0.4rem; padding: 0.6rem 0.8rem; }
.summary dt { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.7; margin: 0; }
.summary dd { margin: 0.2rem 0 0; font-weight: 600; word-break: break-all; }
.outcome { display: inline-block; padding: 0.3rem 0.9rem; border-radius: 0.3rem; font-weight: 700; }
.outcome.pass { background: #1f8b4c33; color: #1f8b4c; }
.outcome.failed { background: #c0262633; color: #c02626; }
.outcome.warning { background: #b8860b33; color: #b8860b; }
.diagnostic { border: 1px solid rgba(128,128,128,0.3); border-left-width: 4px; border-radius: 0.3rem; padding: 0.6rem 0.9rem; margin: 0.75rem 0; }
.diagnostic.error { border-left-color: #c02626; }
.diagnostic.warning { border-left-color: #b8860b; }
.diagnostic.info { border-left-color: #2563eb; }
.diagnostic h3 { margin: 0 0 0.3rem; font-size: 1rem; }
.diagnostic h4 { margin: 0.6rem 0 0.2rem; font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.03em; opacity: 0.75; }
.empty { opacity: 0.7; font-style: italic; }
footer { margin-top: 3rem; font-size: 0.8rem; opacity: 0.7; }
</style>
</head>
<body>
<h1>JMC build report</h1>
<p class="outcome ${statusClass(report.status)}">FINAL STATUS: ${escapeHtml(outcome)}</p>
<dl class="summary">
<div><dt>Project</dt><dd>${escapeHtml(report.project.name)}</dd></div>
<div><dt>Build ID</dt><dd>${escapeHtml(report.buildId)}</dd></div>
<div><dt>Minecraft</dt><dd>${escapeHtml(report.project.minecraftVersion ?? 'not detected')}</dd></div>
<div><dt>Loader</dt><dd>${escapeHtml(report.project.loader ?? 'not detected')}</dd></div>
<div><dt>Mappings</dt><dd>${escapeHtml(report.project.mappingsFormat ?? 'not provided')}</dd></div>
<div><dt>Java</dt><dd>${escapeHtml(report.toolchain.javaVersion ?? 'not resolved')}</dd></div>
<div><dt>Gradle</dt><dd>${escapeHtml(report.toolchain.gradleVersion ?? 'not resolved')}</dd></div>
<div><dt>Build system</dt><dd>${escapeHtml(report.project.buildSystem)}</dd></div>
<div><dt>Duration</dt><dd>${report.durationMs} ms</dd></div>
<div><dt>Platform</dt><dd>${escapeHtml(`${report.toolchain.os}-${report.toolchain.architecture}`)}</dd></div>
</dl>
${
  report.artifact === undefined
    ? '<p class="empty">No artifact was produced.</p>'
    : `<h2>Artifact</h2>
<table>
<tr><th>Path</th><td><code>${escapeHtml(report.artifact.path)}</code></td></tr>
<tr><th>Size</th><td>${report.artifact.sizeBytes} bytes</td></tr>
<tr><th>SHA-256</th><td><code>${escapeHtml(report.artifact.sha256)}</code></td></tr>
<tr><th>Entries</th><td>${report.artifact.entryCount ?? 'n/a'}</td></tr>
<tr><th>Classes</th><td>${report.artifact.classCount ?? 'n/a'}</td></tr>
</table>`
}
<h2>Stages</h2>
<table>
<tr><th>Stage</th><th>Label</th><th>Status</th><th>Duration</th><th>Details</th></tr>
${renderStages(report)}
</table>
<h2>Diagnostics</h2>
${renderDiagnostics(report)}
<h2>Dependencies</h2>
<p>${report.dependencies.direct} direct, ${report.dependencies.transitive} transitive, ${report.dependencies.unresolved.length} unresolved.</p>
<table>
<tr><th>Group</th><th>Artifact</th><th>Version</th><th>Status</th></tr>
${renderDependencyNodes(report.dependencies.graph)}
</table>
${
  report.dependencies.unresolved.length === 0
    ? ''
    : `<h3>Unresolved</h3><ul>${report.dependencies.unresolved
        .map((entry) => `<li><code>${escapeHtml(entry.coordinate)}</code> requested by ${escapeHtml(entry.requestedBy)}: ${escapeHtml(entry.cause)}</li>`)
        .join('')}</ul>`
}
<h2>Repositories</h2>
<ul>${report.repositories.map((repository) => `<li><code>${escapeHtml(repository)}</code></li>`).join('')}</ul>
<h2>Reproducibility lock</h2>
<table>
<tr><th>Field</th><th>Value</th></tr>
<tr><td>Minecraft</td><td>${escapeHtml(report.lock.minecraft.version ?? 'not detected')}</td></tr>
<tr><td>Loader</td><td>${escapeHtml(report.lock.loader.id ?? 'not detected')}</td></tr>
<tr><td>Gradle</td><td>${escapeHtml(report.lock.gradle.version ?? 'not resolved')}</td></tr>
<tr><td>Java major</td><td>${report.lock.java.major ?? 'not resolved'}</td></tr>
<tr><td>JMC</td><td>${escapeHtml(report.lock.toolchain.jmcVersion)}</td></tr>
<tr><td>Lock dependencies</td><td>${report.lock.dependencies.length}</td></tr>
</table>
<footer>Generated by ${escapeHtml(report.tool.name)} ${escapeHtml(report.tool.version)} on ${escapeHtml(report.generatedAt)} using Node ${escapeHtml(report.tool.node)}.</footer>
</body>
</html>
`;
}

export function writeBuildReportHtml(report: BuildReport, destination: string): void {
  const nodeFs = fs;
  const nodePath = path;
  nodeFs.mkdirSync(nodePath.dirname(destination), { recursive: true });
  nodeFs.writeFileSync(destination, renderBuildReportHtml(report), 'utf8');
}