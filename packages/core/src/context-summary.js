export function summarizeContextBundle(bundle, bundlePath) {
  return {
    bundlePath,
    bundle: {
      id: bundle.id,
      includeGlobs: [...(bundle.includeGlobs ?? [])],
      stats: { ...bundle.stats },
      included: bundle.included.map((item) => item.path),
      redactions: bundle.redactions.map((item) => ({
        path: item.path,
        reason: item.reason,
        pattern: item.pattern,
      })),
    },
  };
}
