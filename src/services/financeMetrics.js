import { getKarmanSqlPool } from "../config/tcDb.js";

export async function getThreeWayMatchSummary() {
  const pool = await getKarmanSqlPool("ThreeWayMatch");

  const summaryResult = await pool.request().query(`
    SELECT status_bucket, match_flag, COUNT(*) AS cnt
    FROM dbo.match_results
    GROUP BY status_bucket, match_flag
    ORDER BY cnt DESC
  `);

  const mismatchesResult = await pool.request().query(`
    SELECT TOP 100
      invoice_number, supplier, po_number, bill_amount,
      jira_authorized_amount, amount_variance, status_bucket, matched_at
    FROM dbo.match_results
    WHERE match_flag <> 'Match'
    ORDER BY matched_at DESC
  `);

  const buckets = summaryResult.recordset;
  const total = buckets.reduce((s, b) => s + b.cnt, 0);
  const matched = buckets.filter((b) => b.match_flag === "Match").reduce((s, b) => s + b.cnt, 0);

  return {
    total,
    matched,
    mismatched: total - matched,
    buckets: buckets.map((b) => ({ label: b.status_bucket, matchFlag: b.match_flag, count: b.cnt })),
    mismatches: mismatchesResult.recordset,
  };
}
