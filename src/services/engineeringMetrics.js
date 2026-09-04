import { getKarmanSqlPool } from "../config/tcDb.js";

// Design + COTS part revisions are Karman's real engineering-owned part types
// in Teamcenter; the generic "ItemRevision" base type has no release workflow here.
const TRACKED_TYPES = ["KRM3_DesignRevision", "KRM3_COTSRevision"];

export async function getPartReleaseStatus() {
  const pool = await getKarmanSqlPool("tc");

  const result = await pool.request().query(`
    SELECT
      wso.pobject_type AS partType,
      SUM(CASE WHEN wso.pdate_released IS NOT NULL THEN 1 ELSE 0 END) AS released,
      SUM(CASE WHEN wso.pdate_released IS NULL THEN 1 ELSE 0 END) AS unreleased
    FROM PITEMREVISION ir
    JOIN PWORKSPACEOBJECT wso ON wso.puid = ir.puid
    WHERE wso.pobject_type IN ('${TRACKED_TYPES.join("','")}')
    GROUP BY wso.pobject_type
  `);

  const rows = result.recordset;
  const released = rows.reduce((s, r) => s + r.released, 0);
  const unreleased = rows.reduce((s, r) => s + r.unreleased, 0);

  return {
    released,
    unreleased,
    total: released + unreleased,
    byType: rows.map((r) => ({
      partType: r.partType === "KRM3_DesignRevision" ? "Design Parts" : "COTS Parts",
      released: r.released,
      unreleased: r.unreleased,
      total: r.released + r.unreleased,
    })),
  };
}
