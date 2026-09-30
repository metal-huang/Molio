/**
 * Regression test for: macOS release job dies with "422 Unprocessable Entity /
 * already_exists (field: tag_name)" while the Windows job succeeds.
 *
 * Root cause: the `build` job is a two-entry matrix (Windows x64, macOS arm64)
 * that runs in PARALLEL, and every entry ends with `electron-builder --publish
 * always`. electron-builder creates the GitHub release itself, so both jobs try
 * to create the SAME release and the loser is rejected.
 *
 * Evidence (run 36685374706, v0.3.59): Build Windows 07:45:57→07:48:45 ok,
 * Build macOS 07:46:04→07:48:53 failed. The release went public at 07:48:29Z
 * and the macOS create was rejected at 07:48:30Z — a one-second race. The
 * failure also skipped the OSS upload job, so v0.3.59 never reached users.
 *
 * Fix: serialize the matrix so one platform finishes publishing before the
 * next one starts; the second job then finds the release instead of creating it.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const workflow = readFileSync(
  path.resolve(import.meta.dirname, '../../../.github/workflows/release.yml'),
  'utf-8'
);

/** Slice out a single top-level job block (2-space indent) from the workflow. */
function jobBlock(name) {
  const lines = workflow.split('\n');
  const start = lines.findIndex((line) => line === `  ${name}:`);
  assert.notEqual(start, -1, `job "${name}" not found in release.yml`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^ {2}\S/.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

describe('release workflow publish race', () => {
  it('build matrix publishes to GitHub one platform at a time', () => {
    const build = jobBlock('build');
    assert.match(
      build,
      /^\s+max-parallel:\s*1\s*$/m,
      'build.strategy.max-parallel must be 1 — every matrix entry runs ' +
        '`electron-builder --publish always` and creates the GitHub release ' +
        'itself, so parallel entries race and the loser fails with 422 ' +
        'already_exists (see run 36685374706)'
    );
  });
});
