// Convert captured private build output into a small, non-content diagnostic.
// Never return or print the captured stdout/stderr themselves: this module is
// specifically for preserving the public carrier's sanitized-output boundary.
export function classifyThreadsAffiliateGasBuildFailure(build) {
  const text = `${build?.stdout ?? ''}\n${build?.stderr ?? ''}`

  if (/GAS artifact verification failed/iu.test(text)) {
    return 'GAS_ARTIFACT_CHECK_FAILED'
  }
  if (/@esbuild\/[A-Za-z0-9_-]+[^\n]*could not be found|needed by esbuild/iu.test(text)) {
    return 'ESBUILD_BINARY_MISSING'
  }
  if (/installed esbuild for another platform|platform-specific binary/iu.test(text)) {
    return 'ESBUILD_PLATFORM_MISMATCH'
  }
  if (/ERR_MODULE_NOT_FOUND|Cannot find (?:module|package)|Could not resolve/iu.test(text)) {
    return 'GAS_BUILD_MODULE_RESOLUTION_FAILED'
  }
  if (/EACCES|permission denied/iu.test(text)) {
    return 'GAS_BUILD_PERMISSION_DENIED'
  }
  if (/ENOSPC|no space left on device/iu.test(text)) {
    return 'GAS_BUILD_STORAGE_EXHAUSTED'
  }
  if (/esbuild/iu.test(text)) {
    return 'ESBUILD_EXECUTION_FAILED'
  }
  return 'GAS_BUILD_FAILED'
}
