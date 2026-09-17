import { getKarmanSqlPool } from "../config/tcDb.js";

// "Not yet received" and "Awaiting Invoice" are both just "PO not resolved
// yet" from a $ Approval standpoint. Also seeing "Awaiting Invoice" itself
// split into two legend rows (84 + 18) with nothing but a case/whitespace
// difference between the raw values usp_refresh_match_results writes — so
// this normalizes trim+case before applying the synonym map, instead of
// only matching one exact string.
const BUCKET_LABEL_SYNONYMS = [["Awaiting Invoice", "Not yet received"]];

// "No PO in Brex memo" and "No Jira approval found" are two distinct,
// mutually exclusive status_bucket values (the $ Approval percentages sum to
// 100%, confirming one bucket per record) — their intersection is always 0,
// so "Missing Data" is their union (sum of both counts), not an overlap.
const MISSING_DATA_LABELS = ["No PO in Brex memo", "No Jira approval found", "Awaiting Invoice"];
function mergeBucketLabel(label) {
  const trimmed = (label ?? "").trim();
  for (const [canonical, ...aliases] of BUCKET_LABEL_SYNONYMS) {
    if (trimmed.toLowerCase() === canonical.toLowerCase() || aliases.some((a) => a.toLowerCase() === trimmed.toLowerCase())) {
      return canonical;
    }
  }
  return trimmed;
}

export async function getThreeWayMatchSummary() {
  const pool = await getKarmanSqlPool("ThreeWayMatch");

  const summaryResult = await pool.request().query(`
    SELECT status_bucket, match_flag, COUNT(*) AS cnt
    FROM dbo.match_results
    GROUP BY status_bucket, match_flag
    ORDER BY cnt DESC
  `);

  // matched_at has a single distinct value for the whole table (one batch run),
  // so "ORDER BY matched_at DESC" alone is a no-op tie — a TOP N here previously
  // returned an arbitrary slice that happened to be 100% no-PO rows, hiding every
  // real PO mismatch from the UI. Ordering PO-having rows first (then the tie on
  // matched_at) guarantees those show up; fetching all ~1,400 rows instead of
  // capping in SQL lets the UI's client-side filters (invoice/supplier/PO, and
  // the show/hide-no-PO toggle) search the full set rather than a fixed slice.
  // invoice_status/payment_status/jira_status/is_fully_received are all already
  // populated by usp_refresh_match_results (Brex.staging.stg_expenses.status,
  // JSON_VALUE(raw_json, '$.payment_status'), JiraAnalytics jira_issues.status,
  // and stg_mgfo_po_summary.is_fully_received respectively) — no proc change
  // needed, just selecting what's already there. issue_key reuses the same
  // PO->Jira-issue mapping as the matched view below (cross-database join,
  // same on-prem server).
  const mismatchesResult = await pool.request().query(`
    SELECT
      m.invoice_number, m.supplier, m.po_number, m.bill_amount,
      m.jira_authorized_amount, m.amount_variance, m.status_bucket, m.matched_at,
      m.invoice_status, m.payment_status, m.jira_status, m.is_fully_received,
      (SELECT TOP 1 j.issue_key FROM JiraAnalytics.dbo.jira_issue_purchase_orders j
       WHERE j.po_number = m.po_number ORDER BY j.issue_id DESC) AS issue_key
    FROM dbo.match_results m
    WHERE m.match_flag <> 'Match'
    ORDER BY CASE WHEN m.po_number IS NULL OR m.po_number = '' THEN 1 ELSE 0 END, m.matched_at DESC
  `);

  const matchedResult = await pool.request().query(`
    SELECT
      m.invoice_number, m.supplier, m.po_number, m.bill_amount,
      m.jira_authorized_amount, m.status_bucket,
      m.invoice_status, m.payment_status, m.jira_status, m.is_fully_received,
      (SELECT TOP 1 j.issue_key FROM JiraAnalytics.dbo.jira_issue_purchase_orders j
       WHERE j.po_number = m.po_number ORDER BY j.issue_id DESC) AS issue_key
    FROM dbo.match_results m
    WHERE m.match_flag = 'Match'
    ORDER BY m.matched_at DESC
  `);

  const total = summaryResult.recordset.reduce((s, b) => s + b.cnt, 0);
  const matched = summaryResult.recordset.filter((b) => b.match_flag === "Match").reduce((s, b) => s + b.cnt, 0);

  // $ Approval buckets are a label-only breakdown (the pie/legend has no
  // notion of match_flag) — two raw rows with the same merged label but
  // different match_flag must collapse into one slice, not stay split.
  const labelCounts = new Map();
  summaryResult.recordset.forEach((b) => {
    const label = mergeBucketLabel(b.status_bucket);
    labelCounts.set(label, (labelCounts.get(label) || 0) + b.cnt);
  });
  const buckets = [...labelCounts.entries()].map(([label, count]) => ({ label, count }));
  const missingData = buckets
    .filter((b) => MISSING_DATA_LABELS.includes(b.label))
    .reduce((s, b) => s + b.count, 0);

  return {
    total,
    matched,
    mismatched: total - matched - missingData,
    missingData,
    buckets,
    mismatches: mismatchesResult.recordset.map((r) => ({ ...r, status_bucket: mergeBucketLabel(r.status_bucket) })),
    matchedRecords: matchedResult.recordset.map((r) => ({ ...r, status_bucket: mergeBucketLabel(r.status_bucket) })),
  };
}
