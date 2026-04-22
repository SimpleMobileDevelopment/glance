import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { compareVersions } from 'compare-versions';
import type { ProjectConfig, WidgetModule, Result, Hero } from '../types.ts';
import { card, errorCard, escape, truncatedList, type Tone } from '../render.ts';
import { memoize, conditionalFetch } from '../cache.ts';

const DRIFT_TTL_MS = 10 * 60_000;

type DriftConfig = { catalogs?: string[] };

type Coordinate = { group: string; artifact: string };

type StaleEntry = {
  coordinate: string;
  declared: string;
  latest: string;
};

type CatalogReport = {
  label: string;
  stale: StaleEntry[];
};

function parseCatalog(content: string): { pairs: Array<{ coordinate: Coordinate; declared: string }>; skipped: number } {
  const versions = new Map<string, string>();
  const pairs: Array<{ coordinate: Coordinate; declared: string }> = [];
  const seenRefs = new Set<string>();
  let skipped = 0;

  // Find blocks
  const blockRegex = /^\[([^\]]+)\]\s*$/gm;
  const blocks: Array<{ name: string; start: number; end: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = blockRegex.exec(content)) !== null) {
    blocks.push({ name: m[1].trim(), start: m.index + m[0].length, end: content.length });
  }
  for (let i = 0; i < blocks.length - 1; i++) {
    blocks[i].end = blocks[i + 1].start - blocks[i + 1].name.length - 2; // approx, before next [name]
  }
  // Simpler: recompute end as the start of the next block's header
  const headerRegex = /^\[([^\]]+)\]\s*$/gm;
  const headers: Array<{ name: string; headerStart: number; bodyStart: number }> = [];
  let h: RegExpExecArray | null;
  while ((h = headerRegex.exec(content)) !== null) {
    headers.push({ name: h[1].trim(), headerStart: h.index, bodyStart: h.index + h[0].length });
  }
  const sections: Array<{ name: string; body: string }> = headers.map((cur, idx) => {
    const nextStart = idx + 1 < headers.length ? headers[idx + 1].headerStart : content.length;
    return { name: cur.name, body: content.slice(cur.bodyStart, nextStart) };
  });

  // [versions] block
  for (const sec of sections) {
    if (sec.name !== 'versions') continue;
    const lineRe = /^\s*([A-Za-z0-9_.\-]+)\s*=\s*"([^"]+)"\s*$/gm;
    let lm: RegExpExecArray | null;
    while ((lm = lineRe.exec(sec.body)) !== null) {
      versions.set(lm[1], lm[2]);
    }
  }

  // [libraries] block
  for (const sec of sections) {
    if (sec.name !== 'libraries') continue;
    // Each library entry is one logical line. Split by lines.
    const lines = sec.body.split(/\r?\n/);
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      // Must be name = { ... }
      const entryMatch = /^([A-Za-z0-9_.\-]+)\s*=\s*\{(.+)\}\s*$/.exec(line);
      if (!entryMatch) {
        // string-form like name = "g:a:1.0" or stray; skip + count
        if (/^[A-Za-z0-9_.\-]+\s*=\s*"/.test(line)) skipped++;
        continue;
      }
      const inner = entryMatch[2];
      // Need version.ref
      const refMatch = /version\.ref\s*=\s*"([^"]+)"/.exec(inner);
      if (!refMatch) { skipped++; continue; }
      const ref = refMatch[1];
      if (seenRefs.has(ref)) continue; // first coordinate wins per ref
      const declared = versions.get(ref);
      if (!declared) { skipped++; continue; }

      let group: string | undefined;
      let artifact: string | undefined;
      const moduleMatch = /module\s*=\s*"([^":]+):([^"]+)"/.exec(inner);
      if (moduleMatch) {
        group = moduleMatch[1];
        artifact = moduleMatch[2];
      } else {
        const groupMatch = /group\s*=\s*"([^"]+)"/.exec(inner);
        const nameMatch = /\bname\s*=\s*"([^"]+)"/.exec(inner);
        if (groupMatch && nameMatch) {
          group = groupMatch[1];
          artifact = nameMatch[1];
        }
      }
      if (!group || !artifact) { skipped++; continue; }
      seenRefs.add(ref);
      pairs.push({ coordinate: { group, artifact }, declared });
    }
  }

  return { pairs, skipped };
}

function coordKey(c: Coordinate): string {
  return `${c.group}:${c.artifact}`;
}

async function fetchLatest(c: Coordinate): Promise<string | null> {
  const key = `drift:latest:${coordKey(c)}`;
  return memoize({
    key,
    ttlMs: DRIFT_TTL_MS,
    fetchFresh: async () => {
      const groupPath = c.group.replace(/\./g, '/');
      const repos = [
        `https://repo1.maven.org/maven2/${groupPath}/${c.artifact}/maven-metadata.xml`,
        `https://dl.google.com/dl/android/maven2/${groupPath}/${c.artifact}/maven-metadata.xml`,
        `https://jitpack.io/${groupPath}/${c.artifact}/maven-metadata.xml`,
      ];
      for (const url of repos) {
        const res = await conditionalFetch(url);
        if (!res.ok) continue;
        const xml = await res.text();
        const latestMatch = /<latest>([^<]+)<\/latest>/.exec(xml);
        if (latestMatch) return latestMatch[1].trim();
        const releaseMatch = /<release>([^<]+)<\/release>/.exec(xml);
        if (releaseMatch) return releaseMatch[1].trim();
        const versions = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map(m => m[1].trim());
        if (versions.length > 0) return versions[versions.length - 1];
      }
      return null;
    },
  });
}

function isStale(declared: string, latest: string): boolean {
  try {
    return compareVersions(declared, latest) < 0;
  } catch {
    return declared !== latest;
  }
}

function deriveLabel(catalogPath: string): string {
  return path.basename(path.dirname(path.dirname(catalogPath)));
}

async function processCatalog(
  catalogPath: string,
  errors: string[],
): Promise<Result<CatalogReport>> {
  let content: string;
  try {
    content = await readFile(catalogPath, 'utf8');
  } catch (e) {
    return { ok: false, error: `${catalogPath}: ${(e as Error).message}` };
  }
  const { pairs } = parseCatalog(content);
  const stale: StaleEntry[] = [];

  await Promise.all(pairs.map(async ({ coordinate, declared }) => {
    const key = coordKey(coordinate);
    try {
      const latest = await fetchLatest(coordinate);
      if (latest == null) {
        errors.push(`${key}: not found on Maven Central, Google Maven, or JitPack`);
        return;
      }
      if (isStale(declared, latest)) {
        stale.push({ coordinate: key, declared, latest });
      }
    } catch (e) {
      errors.push(`${key}: ${(e as Error).message}`);
    }
  }));

  stale.sort((a, b) => a.coordinate.localeCompare(b.coordinate));
  return { ok: true, data: { label: deriveLabel(catalogPath), stale } };
}

function renderCatalog(report: CatalogReport): string {
  const header = `<h3>${escape(report.label)} <span class="count">${report.stale.length} stale</span></h3>`;
  if (report.stale.length === 0) {
    return `${header}<p class="muted">All current ✓</p>`;
  }
  const rows = report.stale.map(s => `
    <li>
      <span class="repo">${escape(s.coordinate)}</span>
      <span class="warn">${escape(s.declared)} → ${escape(s.latest)}</span>
    </li>`);
  return `${header}${truncatedList(rows)}`;
}

async function render(project: ProjectConfig): Promise<{ html: string; hero?: Hero }> {
  const config = (project.widgets.drift ?? {}) as DriftConfig;
  const catalogs = config.catalogs ?? [];
  if (catalogs.length === 0) {
    return {
      html: card('Dependency drift', `<p class="muted">No catalogs configured. Add some to project.json under widgets.drift.catalogs.</p>`),
    };
  }

  const errors: string[] = [];
  const reports = await Promise.all(catalogs.map(c => processCatalog(c, errors)));

  const sections: string[] = [];
  for (const r of reports) {
    if (!r.ok) {
      sections.push(`<p class="error">${escape(r.error)}</p>`);
      continue;
    }
    sections.push(renderCatalog(r.data));
  }

  let body = sections.join('');
  if (errors.length > 0) {
    console.error('[drift] dependencies that could not be checked:');
    for (const e of errors) console.error(`  - ${e}`);
    body += `<p class="meta">${errors.length} dependencies couldn't be resolved in any known repo.</p>`;
  }

  const totalStale = reports.reduce((n, r) => n + (r.ok ? r.data.stale.length : 0), 0);
  const tone: Tone = totalStale === 0 ? 'green' : totalStale >= 5 ? 'red' : 'amber';
  const hero: Hero = { value: totalStale, tone, label: 'stale' };
  return {
    html: card('Dependency drift', body, { hero }),
    hero,
  };
}

export const drift: WidgetModule = {
  id: 'drift',
  title: 'Dependency drift',
  configFields: [
    {
      type: 'multiline-list',
      key: 'catalogs',
      label: 'Version catalog paths',
      placeholder: 'C:\\path\\to\\libs.versions.toml',
      description: 'Absolute paths to libs.versions.toml files.',
    },
  ],
  run: async project => render(project),
};
