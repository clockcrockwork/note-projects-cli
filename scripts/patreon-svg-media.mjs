// Approved PTN-PUB-003 inline assets only; covers have a separate export boundary.
const APPROVED_SVG_MEDIA = new Set([
  'source-bg-02-crossing.png',
  'comparison.png',
  'comparison-whale-detail-v2-v3.png',
  'comparison-bg-02-crossing.png',
  'bg-02-crossing.png',
  'bg-02-crossing-teal.png',
  'comparison-bg-01-trench.png',
].map((name) => `media/patreon/ai-image-to-svg/${name}`))

export function isApprovedPatreonSvgMedia(path) {
  return APPROVED_SVG_MEDIA.has(path)
}
