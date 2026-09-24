import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const source = fs.readFileSync(
  new URL('../scripts/run-ccw-publication-console.mjs', import.meta.url),
  'utf8',
);

test('CCW console exports the explicit payload-boundary helper', () => {
  assert.match(
    source,
    /path === 'tools\/publication-console\/payload-boundary\.mjs'/,
  );
  assert.match(
    source,
    /PUBLICATION_CONSOLE_PAYLOAD_BOUNDARY_MISSING/,
  );
});


test('CCW console exports both creator review gates required by the builder', () => {
  assert.match(
    source,
    /path === 'tools\/workflow\/creator-review-gate\.mjs'/,
  );
  assert.match(
    source,
    /path === 'tools\/workflow\/note-creator-review-gate\.mjs'/,
  );
  assert.match(
    source,
    /PUBLICATION_CONSOLE_CREATOR_REVIEW_GATE_MISSING/,
  );
  assert.match(
    source,
    /PUBLICATION_CONSOLE_NOTE_CREATOR_REVIEW_GATE_MISSING/,
  );
});


test('CCW console exports creator-review gate dependencies required by the builder', () => {
  assert.match(
    source,
    /path === 'tools\/workflow\/creator-review-gate\.mjs'/,
  );
  assert.match(
    source,
    /path === 'tools\/workflow\/note-creator-review-gate\.mjs'/,
  );
  assert.match(
    source,
    /PUBLICATION_CONSOLE_CREATOR_REVIEW_GATE_MISSING/,
  );
  assert.match(
    source,
    /PUBLICATION_CONSOLE_NOTE_CREATOR_REVIEW_GATE_MISSING/,
  );
});

test('CCW console classifies missing imported modules as build input failures', () => {
  assert.match(
    source,
    /ERR_MODULE_NOT_FOUND/,
  );
  assert.match(
    source,
    /Cannot find module/,
  );
});


test('CCW console exports approved public-ready cover media', () => {
  assert.match(
    source,
    /\^covers\\\/media\\\/public-ready\\\/.+\\\.\(\?:png\|jpe\?g\|webp\|gif\)\$/,
  );
});

test('CCW console uploads generated HTML before creating the Vercel deployment', () => {
  assert.match(source, /\/v2\/files\?/)
  assert.match(source, /'x-Vercel-Digest': uploadedFile\.sha/)
  assert.match(source, /files: \[\{ file: uploadedFile\.file, sha: uploadedFile\.sha, size: uploadedFile\.size \}\]/)
  assert.doesNotMatch(source, /files: \[\{ file: 'index\.html', data: html \}\]/)
})
