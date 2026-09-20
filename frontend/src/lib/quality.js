/* Data-quality report shapes.
   The frontend computes { healthPct, missingPct, duplicates, invalidIds,
   inconsistent, rows } (lib/mapping.js -> computeDataQuality); the backend
   stores { score, issues } (services/dataQuality.js -> assessQuality).
   Everything that displays a report goes through this so either shape works. */

export function normalizeQuality(quality) {
  if (!quality) return null;
  if (typeof quality.healthPct === "number") return quality;
  // backend shape: { score, issues: [...] }
  if (typeof quality.score === "number") {
    const issues = quality.issues || [];
    return {
      healthPct: quality.score,
      missingPct: null,
      duplicates: issues.filter((i) => i.type === "duplicate").length,
      invalidIds: issues.filter((i) => i.type === "invalid_id").length,
      inconsistent: issues.filter((i) => i.type === "inconsistent").length,
      unmapped: issues.filter((i) => i.type === "unmapped").length,
      anomalies: issues.filter((i) => i.type === "anomaly").length,
      rows: quality.rows,
      issues,
    };
  }
  return quality;
}
