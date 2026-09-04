import { getPool, sql } from "../config/db.js";

const PROD_SITE_CODE = "KRM_01";

export async function getPastDuePOs() {
  const pool = await getPool();
  const result = await pool.request().input("site", sql.VarChar, PROD_SITE_CODE).query(`
    SELECT
      order_header_number,
      order_header_partner_name,
      MIN(order_line_due_date) AS earliest_due_date,
      COUNT(*) AS late_line_count
    FROM [external].supplier_on_time_delivery
    WHERE order_header_site_code = @site
      AND order_line_status_code IN ('NEW', 'IN_PROGRESS')
      AND order_line_is_late = 1
    GROUP BY order_header_number, order_header_partner_name
    ORDER BY earliest_due_date ASC
  `);

  const rows = result.recordset;

  const bySupplier = new Map();
  for (const r of rows) {
    const key = r.order_header_partner_name || "Unknown";
    bySupplier.set(key, (bySupplier.get(key) || 0) + 1);
  }
  const supplierBreakdown = [...bySupplier.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count);

  return {
    count: rows.length,
    supplierBreakdown,
    pos: rows.map((r) => ({
      poNumber: r.order_header_number,
      supplier: r.order_header_partner_name,
      earliestDueDate: r.earliest_due_date,
      lateLineCount: r.late_line_count,
    })),
  };
}
