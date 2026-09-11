import { getKarmanSqlPool } from "../config/tcDb.js";

const RECENT_REPORTS_LIMIT = 10;
const TIME_TO_REPORT_LIMIT = 20;
const OLDEST_OPEN_ACTIONS_LIMIT = 10;
const LEADING_LAGGING_TARGET_RATIO = 20;

const AGING_BUCKET_SQL = `
  CASE
    WHEN age_days <= 7 THEN '<7d'
    WHEN age_days BETWEEN 8 AND 30 THEN '8-30d'
    WHEN age_days BETWEEN 31 AND 60 THEN '31-60d'
    ELSE '>60d'
  END`;
const AGING_BUCKET_ORDER = ["<7d", "8-30d", "31-60d", ">60d"];

// TRIR = recordable incidents * 200,000 / hours worked, and can't be computed yet:
// dbo.hours_worked has no rows loaded, and there's no reliable active-employee-count
// source to pair with it either (Entra/Gusto integration is a known upcoming blocker
// for other provisioning work too). Wire up both a real hours_worked pipeline and a
// headcount source before computing this instead of returning trir.available: false.
//
// CANCELLED-TICKET HANDLING: Jira's status-category system has no "Cancelled"
// category of its own — a report with raw status = 'Cancelled' still reports
// status_category = 'Done', indistinguishable from a genuinely completed
// report to anything that only reads status_category. Every query below
// against dbo.safety_reports therefore filters on the raw status column
// (status <> 'Cancelled') rather than relying on status_category, so a
// cancelled report never counts as a real recordable incident, never shows
// up in Recent Safety Reports looking like a completed one, and never
// contributes to the leading:lagging or time-to-report trends. (The
// further_actions queries below don't need this: status_category <> 'Done'
// already excludes Cancelled there, since Cancelled maps to the Done
// category — there's no separate raw-status column being bypassed.)
async function getTrir(pool) {
  const result = await pool.request().query(`
    SELECT COUNT(*) AS cnt FROM dbo.safety_reports WHERE osha_recordable = 'Yes' AND status <> 'Cancelled'
  `);
  return {
    available: false,
    reason: "Hours worked data not yet connected — TRIR unavailable",
    oshaRecordableCount: result.recordset[0].cnt,
  };
}

async function getLeadingLaggingTrend(pool) {
  const result = await pool.request().query(`
    SELECT
      DATEFROMPARTS(YEAR(occurrence_date), MONTH(occurrence_date), 1) AS period,
      SUM(CASE WHEN leading_or_lagging = 'Leading' THEN 1 ELSE 0 END) AS leadingCount,
      SUM(CASE WHEN leading_or_lagging = 'Lagging' THEN 1 ELSE 0 END) AS laggingCount
    FROM dbo.safety_reports
    WHERE occurrence_date IS NOT NULL AND status <> 'Cancelled'
    GROUP BY DATEFROMPARTS(YEAR(occurrence_date), MONTH(occurrence_date), 1)
    ORDER BY period ASC
  `);
  return {
    targetRatio: LEADING_LAGGING_TARGET_RATIO,
    trend: result.recordset.map((r) => ({
      period: r.period,
      leadingCount: r.leadingCount,
      laggingCount: r.laggingCount,
      ratio: r.laggingCount > 0 ? r.leadingCount / r.laggingCount : null,
    })),
  };
}

async function getRecentReports(pool) {
  // created_date is a date (no time component), so multiple reports filed on
  // the same calendar day have no deterministic order from created_date alone
  // — ORDER BY created_date DESC only was returning arbitrary DB row order
  // among same-day ties (the exact non-determinism bug already found once in
  // Finance's matched_at). issue_key's numeric suffix is a reliable proxy for
  // filing order within a tied day, since Jira keys are assigned sequentially.
  const result = await pool.request().query(`
    SELECT TOP ${RECENT_REPORTS_LIMIT} issue_key, description, safety_report_type, status_category, created_date
    FROM dbo.safety_reports
    WHERE status <> 'Cancelled'
    ORDER BY created_date DESC, TRY_CAST(RIGHT(issue_key, LEN(issue_key) - CHARINDEX('-', issue_key)) AS INT) DESC
  `);
  return result.recordset.map((r) => ({
    issueKey: r.issue_key,
    title: r.description,
    reportType: r.safety_report_type,
    statusCategory: r.status_category,
    createdDate: r.created_date,
  }));
}

async function getTimeToReport(pool) {
  const result = await pool.request().query(`
    SELECT TOP ${TIME_TO_REPORT_LIMIT} issue_key, occurrence_date, days_to_report
    FROM dbo.safety_reports
    WHERE occurrence_date IS NOT NULL AND status <> 'Cancelled'
    ORDER BY occurrence_date DESC
  `);
  return result.recordset
    .map((r) => ({
      issueKey: r.issue_key,
      occurrenceDate: r.occurrence_date,
      daysToReport: r.days_to_report,
    }))
    .reverse();
}

// Widgets 5 & 6 (further-action aging + oldest open further actions) both filter
// on status_category <> 'Done' rather than the view's own is_open flag, matching
// jiraService.js's existing "statusCategory != Done" convention for open work.
async function getFurtherActionAging(pool) {
  const result = await pool.request().query(`
    SELECT ${AGING_BUCKET_SQL} AS bucket, COUNT(*) AS cnt
    FROM dbo.further_actions
    WHERE status_category <> 'Done'
    GROUP BY ${AGING_BUCKET_SQL}
  `);
  const counts = new Map(result.recordset.map((r) => [r.bucket, r.cnt]));
  return AGING_BUCKET_ORDER.map((bucket) => ({ bucket, count: counts.get(bucket) || 0 }));
}

async function getOldestOpenActions(pool) {
  const result = await pool.request().query(`
    SELECT TOP ${OLDEST_OPEN_ACTIONS_LIMIT} issue_key, assignee, age_days
    FROM dbo.further_actions
    WHERE status_category <> 'Done'
    ORDER BY age_days DESC
  `);
  return result.recordset.map((r) => ({
    issueKey: r.issue_key,
    assignee: r.assignee,
    ageDays: r.age_days,
  }));
}

export async function getSafetyOverview() {
  const pool = await getKarmanSqlPool("JiraAnalytics");

  const [trir, leadingLaggingRatio, recentReports, timeToReport, furtherActionAging, oldestOpenActions] =
    await Promise.all([
      getTrir(pool),
      getLeadingLaggingTrend(pool),
      getRecentReports(pool),
      getTimeToReport(pool),
      getFurtherActionAging(pool),
      getOldestOpenActions(pool),
    ]);

  return { trir, leadingLaggingRatio, recentReports, timeToReport, furtherActionAging, oldestOpenActions };
}
