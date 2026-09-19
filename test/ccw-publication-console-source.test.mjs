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
