import assert from 'node:assert/strict'
import test from 'node:test'

import { classifyThreadsAffiliateGasBuildFailure } from '../scripts/threads-affiliates-build-diagnostic.mjs'

test('classifies known GAS build failures without returning captured content', () => {
  const cases = [
    ['GAS_ARTIFACT_CHECK_FAILED', 'Error: GAS artifact verification failed:\n- generated code depends on Buffer'],
    ['ESBUILD_BINARY_MISSING', 'Error: The package "@esbuild/linux-x64" could not be found, and is needed by esbuild.'],
    ['ESBUILD_PLATFORM_MISMATCH', 'You installed esbuild for another platform than the one you are currently using.'],
    ['GAS_BUILD_MODULE_RESOLUTION_FAILED', 'Error [ERR_MODULE_NOT_FOUND]: Cannot find package x'],
    ['GAS_BUILD_PERMISSION_DENIED', 'EACCES: permission denied, mkdir /workspace/dist'],
    ['GAS_BUILD_STORAGE_EXHAUSTED', 'ENOSPC: no space left on device'],
    ['ESBUILD_EXECUTION_FAILED', 'esbuild exited unexpectedly'],
    ['GAS_BUILD_FAILED', 'some unknown private build error'],
  ]

  for (const [expected, stderr] of cases) {
    assert.equal(classifyThreadsAffiliateGasBuildFailure({ stdout: '', stderr }), expected)
  }
})
