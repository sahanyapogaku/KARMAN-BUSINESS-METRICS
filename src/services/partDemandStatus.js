import { getPool } from "../config/db.js";
import { getKarmanSqlPool } from "../config/tcDb.js";
import sql from "mssql";

const DEMAND_TYPE = "MasterSchedule";
// "Inventory" is deliberately not queried from mgfo.summary_report_view here —
// see getInventoryLots() below for why it's sourced differently.
const NON_INVENTORY_SUPPLY_TYPES = ["PurchaseOrderLine", "PlannedWorkOrder", "PlannedPurchaseOrder"];
const ORPHAN_TYPES = ["OrphanInventory", "OrphanPurchaseOrderLine", "OrphanWipTrace"];

const FULFILLED_BY_LABEL = {
  Inventory: "Inventory",
  PurchaseOrderLine: "PO",
  PlannedWorkOrder: "Work Order (planned)",
  PlannedPurchaseOrder: "PO (planned)",
};

const ORPHAN_FULFILLED_BY_LABEL = {
  OrphanInventory: "Inventory (Orphan)",
  OrphanPurchaseOrderLine: "PO (Orphan)",
  OrphanWipTrace: "WIP (Orphan)",
};

// mgfo.summary_report_view mirrors Manufacturo's mrp.SummaryReportView (synced
// on-prem nightly by mgfo_replica_2/extract_to_onprem.py) — a decoded view over
// the raw mrp.scheduled_object table (Type/PedigreeCode as text, no hand-decoding
// of tinyint codes needed). This replaces the old per-type live-Azure queries
// (mrp.master_schedule_item / external.purchase_order_overview / wip_order_overview
// / inventory_overview) with the single unified source the ETL project's own
// docstring says was intended for this report all along.
async function getMgfoPool() {
  return getKarmanSqlPool("mgfo");
}

// mgfo.products has one row PER SITE for the same part code (2,026 of ~5,328
// codes are multi-site) — an unqualified "TOP 1" here was picking an arbitrary
// site's id, and for a part whose MRP activity lives entirely under a
// different site, that silently produced zero demand/supply/orphans with no
// error at all (looked like "no data" when the data was there, just under a
// sibling product_id). Resolving every id for the code and querying across
// all of them avoids ever having to guess which site is "the right one".
async function resolveProductIds(pool, partNumber) {
  const result = await pool.request().input("code", sql.NVarChar, partNumber).query(`
    SELECT id FROM mgfo.products WHERE code = @code
  `);
  return result.recordset.map((r) => r.id);
}

// Rev isn't on mgfo.summary_report_view at all. mgfo.product_revisions (added
// on-prem since this was written) fills the gap with the product's current
// default/active revision — a best-effort substitute, not a confirmed fact
// about any specific demand row (mrp.scheduled_object/master_schedule_item
// carry no revision column, so which revision was actually demanded is
// genuinely unrecorded upstream). Correlated TOP 1, not a plain join: a
// product_id can have multiple revisions, and a naive join would fan out rows
// exactly like the resolveProductIds bug did for multi-site product ids.
// Builds a parameterized "IN (@pid0, @pid1, ...)" clause for a variable-length
// list of GUIDs — mssql has no native array binding, and string-concatenating
// GUIDs directly into SQL would reopen an injection risk.
function bindProductIdList(request, productIds) {
  return productIds.map((id, i) => {
    request.input(`pid${i}`, sql.UniqueIdentifier, id);
    return `@pid${i}`;
  }).join(",");
}

const DEFAULT_REVISION_SUBQUERY = `(
  SELECT TOP 1 pr.revision FROM mgfo.product_revisions pr
  WHERE pr.product_id = s.ProductId AND pr.is_default = 1
  ORDER BY pr.active DESC
)`;

async function getDemandLines(pool, productIds) {
  const request = pool.request();
  const idList = bindProductIdList(request, productIds);
  const result = await request.query(`
    SELECT s.ScheduledObjectId, s.SourceId, s.DueDate, s.Quantity, s.PedigreeCode,
      ${DEFAULT_REVISION_SUBQUERY} AS DefaultRevision
    FROM mgfo.summary_report_view s
    WHERE s.Type = '${DEMAND_TYPE}' AND s.ProductId IN (${idList})
    ORDER BY s.DueDate ASC
  `);
  return result.recordset.map((r) => ({
    id: r.ScheduledObjectId,
    needDate: r.DueDate,
    rev: r.DefaultRevision,
    pedigree: r.PedigreeCode,
    quantity: r.Quantity,
    remaining: r.Quantity,
    sourceId: r.SourceId,
  }));
}

// SourceId resolution: PurchaseOrderLine -> mgfo.purchase_order_overview.order_line_id
// (PO# + rev). PlannedWorkOrder/PlannedPurchaseOrder have no mirrored raw table
// yet (MRP hasn't created a real WO/PO for them) — reference stays null for
// those two, but rev falls back to the default-revision subquery.
// order_line_status_code on mgfo.purchase_order_overview is 'COMPLETED' when
// quantity_completed == quantity_ordered (checked live against sample rows),
// 'IN_PROGRESS' otherwise — order_line_quantity_ready_to_receive is NULL on
// every row checked, not usable. purchase_order_overview has no lot-level
// location (only order_header_site_code, coarser than inventory_overview's
// site/area/location) and no join key back to a specific inventory lot, so
// a COMPLETED line surfaces the site it was received at, not an exact rack.
function poLineLocation(isPoType, statusCode, siteCode) {
  if (!isPoType) return null;
  return statusCode === "COMPLETED" ? siteCode || "Received" : "Supplier In Progress";
}

async function getSupplyLines(pool, productIds) {
  const request = pool.request();
  const idList = bindProductIdList(request, productIds);
  const result = await request.query(`
    SELECT s.ScheduledObjectId, s.SourceId, s.Type, s.EcdDate, s.Quantity, s.PedigreeCode,
      po.order_header_number, po.order_line_product_revision,
      po.order_line_status_code, po.order_header_site_code,
      ${DEFAULT_REVISION_SUBQUERY} AS DefaultRevision
    FROM mgfo.summary_report_view s
    LEFT JOIN mgfo.purchase_order_overview po ON s.Type = 'PurchaseOrderLine' AND po.order_line_id = s.SourceId
    WHERE s.Type IN (${NON_INVENTORY_SUPPLY_TYPES.map((t) => `'${t}'`).join(",")}) AND s.ProductId IN (${idList})
      -- Sites ending in _TEST (KRM01_TEST, TRANSIT_TEST) are Manufacturo's
      -- test-environment mirrors of the real sites (KRM_01, TRANSIT) —
      -- checked live: PO lines under POKRM01_TEST... are test data, not real
      -- outstanding supply, so they're excluded the same way CANCELLED lines
      -- are in getOrphans() below.
      AND (po.order_header_site_code IS NULL OR RIGHT(po.order_header_site_code, 5) <> '_TEST')
    ORDER BY s.EcdDate ASC
  `);
  return result.recordset.map((r) => {
    const isPoType = r.Type === "PurchaseOrderLine";
    const reference = isPoType ? r.order_header_number : null;
    const instanceRev = isPoType ? r.order_line_product_revision : null;
    const rev = instanceRev ?? r.DefaultRevision;
    return {
      id: r.ScheduledObjectId,
      sourceId: r.SourceId,
      estimatedCompletionDate: r.EcdDate,
      rev,
      quantity: r.Quantity,
      remaining: r.Quantity,
      pedigree: r.PedigreeCode,
      fulfilledBy: FULFILLED_BY_LABEL[r.Type],
      reference,
      location: poLineLocation(isPoType, r.order_line_status_code, r.order_header_site_code),
      source: r.Type,
    };
  });
}

// mgfo.summary_report_view's "Inventory" Type rows are NOT usable for
// per-lot detail: checked live against all 20,721 Inventory/OrphanInventory
// rows in mrp.SummaryReportView — SourceId equals ProductId on every single
// one. It's not a reference to a specific inventory record at all; these rows
// represent aggregate on-hand quantity for the product, with no lot-level
// pegging exposed by MRP. So "Inventory" supply is sourced directly from
// mgfo.inventory_overview by product_id instead — one row per real lot, each
// with its own serial/lot reference, location, and revision. This also
// resolves the earlier "unconfirmed BLOCKED assumption" flag: inventory_status
// is now read from the real per-lot record, not copied from the MRP view.
async function getInventoryLots(pool, productIds) {
  const request = pool.request();
  const idList = bindProductIdList(request, productIds);
  const result = await request.query(`
    SELECT inventory_id, quantity_on_hand, product_revision, pedigree_code,
      trace_serial_number, trace_lot_number, itag_code, site_code, area_code, location_code
    FROM mgfo.inventory_overview
    WHERE product_id IN (${idList}) AND inventory_status = 'AVAILABLE'
      -- Test-site mirror (KRM01_TEST/TRANSIT_TEST) lots aren't real on-hand
      -- stock — see getSupplyLines' comment for the same _TEST convention.
      AND RIGHT(site_code, 5) <> '_TEST'
  `);
  return result.recordset.map((r) => ({
    id: r.inventory_id,
    sourceId: r.inventory_id,
    estimatedCompletionDate: null, // already on hand — sorts first, see allocate()
    rev: r.product_revision,
    quantity: r.quantity_on_hand,
    remaining: r.quantity_on_hand,
    pedigree: r.pedigree_code,
    fulfilledBy: "Inventory",
    reference: r.trace_serial_number || r.trace_lot_number || r.itag_code || null,
    location: [r.site_code, r.area_code, r.location_code].filter(Boolean).join(" / ") || null,
    source: "Inventory",
  }));
}

// Non-AVAILABLE lots cannot satisfy demand, but should still be visible in a
// part's inventory position. inventory_overview has no NC identifier, so the
// API deliberately returns null instead of inventing a relationship or URL.
async function getBlockedInventoryLots(pool, productIds) {
  const request = pool.request();
  const idList = bindProductIdList(request, productIds);
  const result = await request.query(`
    SELECT inventory_id, inventory_status, quantity_on_hand, product_revision,
      pedigree_code, trace_serial_number, trace_lot_number, itag_code,
      site_code, area_code, location_code
    FROM mgfo.inventory_overview
    WHERE product_id IN (${idList}) AND inventory_status <> 'AVAILABLE'
      AND RIGHT(site_code, 5) <> '_TEST'
  `);
  return result.recordset.map((r) => ({
    id: r.inventory_id,
    status: r.inventory_status,
    rev: r.product_revision,
    quantity: r.quantity_on_hand,
    reference: r.trace_serial_number || r.trace_lot_number || r.itag_code || null,
    location: [r.site_code, r.area_code, r.location_code].filter(Boolean).join(" / ") || null,
    pedigree: r.pedigree_code,
    nonConformance: null,
  }));
}

// Multiple scheduled_object rows can share the same SourceId (the same real
// PO line / inventory record surfacing once per MRP run in the snapshot) —
// checked live: one part had 37 orphan rows all pointing at a single PO line.
// These are exact repeats of the same line (identical Quantity each time),
// not distinct quantities to add up — SUM(Quantity) multiplied the real qty
// by the occurrence count (a qty-3 PO line duplicated 40x showed as 120).
// MAX(Quantity) takes the real per-line quantity once; COUNT(*) still feeds
// the "(Nx)" occurrences hint, just no longer folded into the qty itself.
// SourceId is resolved to an actual PO# for OrphanPurchaseOrderLine the same
// way getSupplyLines resolves it.
//
// OrphanInventory does NOT get the same reference/location treatment: like
// the "Inventory" supply type, its SourceId equals ProductId (checked live,
// same finding as getInventoryLots' comment) — it's an aggregate quantity,
// not a specific lot. Unlike matched "Inventory" supply, there's no way to
// correctly attribute this to specific real lots either: MRP doesn't expose
// *which* of a product's lots are "orphaned" (unclaimed) vs. pegged to demand
// — both draw from the same physical pool. Picking lots to show here would be
// a guess dressed up as data, so orphan inventory stays aggregate-only
// (quantity, no reference/location) rather than fabricating an attribution.
//
// OrphanWipTrace has no mirrored raw table to resolve against at all, so it
// only ever groups by SourceId itself.
async function getOrphans(pool, productIds) {
  const request = pool.request();
  const idList = bindProductIdList(request, productIds);
  // Alias is `s` (not `o`) so DEFAULT_REVISION_SUBQUERY's hardcoded `s.ProductId`
  // correlation works unchanged. SQL Server rejects MAX() wrapped around a
  // subquery ("aggregate function on an expression containing ... a
  // subquery") — so ProductId joins GROUP BY instead (safe: constant per
  // SourceId, same duplicate-row case the rest of this function handles) and
  // the subquery is selected directly rather than aggregated.
  const result = await request.query(`
    SELECT
      s.Type, s.SourceId,
      MAX(s.Quantity) AS totalQuantity,
      COUNT(*) AS occurrences,
      MAX(s.PedigreeCode) AS pedigree,
      MAX(s.EcdDate) AS ecdDate,
      MAX(po.order_header_number) AS poReference,
      MAX(po.order_line_product_revision) AS orderLineProductRevision,
      MAX(po.order_line_status_code) AS orderLineStatusCode,
      MAX(po.order_header_site_code) AS orderHeaderSiteCode,
      ${DEFAULT_REVISION_SUBQUERY} AS defaultRevision
    FROM mgfo.summary_report_view s
    LEFT JOIN mgfo.purchase_order_overview po ON s.Type = 'OrphanPurchaseOrderLine' AND po.order_line_id = s.SourceId
    WHERE s.Type IN (${ORPHAN_TYPES.map((t) => `'${t}'`).join(",")}) AND s.ProductId IN (${idList})
      -- A cancelled line isn't real outstanding supply regardless of its
      -- quantity — checked live: one such line (order_line_quantity_ordered
      -- = 1) still carried an orphan Quantity of 148, clearly stale/garbage
      -- data on a line nobody expects fulfilled.
      AND NOT (s.Type = 'OrphanPurchaseOrderLine' AND po.order_line_status_code = 'CANCELLED')
      -- Test-site (KRM01_TEST/TRANSIT_TEST) PO lines aren't real outstanding
      -- supply either — same _TEST convention as getSupplyLines. This is a
      -- separate case from the CANCELLED one above: checked live, part
      -- 1000005-000 still had two live (non-cancelled) qty-148 lines under
      -- POKRM01_TEST00000006, both real Manufacturo test data.
      AND (po.order_header_site_code IS NULL OR RIGHT(po.order_header_site_code, 5) <> '_TEST')
    GROUP BY s.Type, s.SourceId, s.ProductId
    ORDER BY totalQuantity DESC
  `);
  return result.recordset.map((r) => {
    const isPoType = r.Type === "OrphanPurchaseOrderLine";
    const instanceRev = isPoType ? r.orderLineProductRevision : null;
    return {
      sourceId: r.SourceId,
      type: r.Type,
      reference: r.poReference || null,
      poReference: r.poReference || null,
      location: poLineLocation(isPoType, r.orderLineStatusCode, r.orderHeaderSiteCode),
      estimatedCompletionDate: r.ecdDate,
      quantity: r.totalQuantity,
      occurrences: r.occurrences,
      pedigree: r.pedigree,
      rev: instanceRev ?? r.defaultRevision,
    };
  });
}

async function getPartHeader(pool, partNumber) {
  const result = await pool
    .request()
    .input("partNumber", sql.NVarChar, partNumber)
    .query(`
      SELECT TOP 1 p.code, p.revision, p.is_make, p.is_buy, p.lead_time, d.ProductName
      FROM [external].products p
      LEFT JOIN master.MRP_ProductsDetails d ON d.ProductCode = p.code
      WHERE p.code = @partNumber AND p.active = 1
      ORDER BY p.revision DESC
    `);
  if (!result.recordset.length) return null;
  const r = result.recordset[0];
  return {
    partNumber: r.code,
    revision: r.revision,
    description: r.ProductName,
    isMake: r.is_make,
    isBuy: r.is_buy,
    leadTimeDays: r.lead_time,
  };
}

// 1:1 FIFO pegging: demand sorted by need date, supply sorted by estimated
// completion (Inventory rows carry a real EcdDate on this view — no special-case
// "available now" null handling needed here, unlike the old live-query version).
function allocate(demandLines, supplyLines) {
  const demand = demandLines.map((d) => ({ ...d }));
  const supply = supplyLines
    .map((s) => ({ ...s }))
    .sort((a, b) => {
      const aDate = a.estimatedCompletionDate ? new Date(a.estimatedCompletionDate).getTime() : Infinity;
      const bDate = b.estimatedCompletionDate ? new Date(b.estimatedCompletionDate).getTime() : Infinity;
      return aDate - bDate;
    });

  const rows = [];
  let supplyIdx = 0;

  for (const d of demand) {
    let remaining = d.remaining;
    if (remaining <= 0) continue;

    while (remaining > 0 && supplyIdx < supply.length) {
      const s = supply[supplyIdx];
      if (s.remaining <= 0) {
        supplyIdx++;
        continue;
      }
      const qty = Math.min(remaining, s.remaining);
      rows.push({
        demand: { needDate: d.needDate, rev: d.rev, pedigree: d.pedigree, quantity: qty },
        supply: {
          estimatedCompletionDate: s.estimatedCompletionDate,
          rev: s.rev,
          fulfilledBy: s.fulfilledBy,
          reference: s.reference,
          location: s.location,
          pedigree: s.pedigree,
          quantity: qty,
        },
      });
      remaining -= qty;
      s.remaining -= qty;
      if (s.remaining <= 0) supplyIdx++;
    }

    if (remaining > 0) {
      rows.push({
        demand: { needDate: d.needDate, rev: d.rev, pedigree: d.pedigree, quantity: remaining },
        supply: null,
      });
    }
  }

  // Zero demand lines for this part: every supply line is orphaned by
  // definition, not leftover from a match — show each as its own row
  // (no demand to peg against) instead of dropping them from the table.
  if (demand.length === 0) {
    for (const s of supply) {
      rows.push({
        demand: { needDate: null, rev: null, pedigree: null, quantity: 0 },
        supply: {
          estimatedCompletionDate: s.estimatedCompletionDate,
          rev: s.rev,
          fulfilledBy: s.fulfilledBy,
          reference: s.reference,
          location: s.location,
          pedigree: s.pedigree,
          quantity: s.remaining,
        },
      });
    }
  }

  return { rows, remainingSupply: demand.length === 0 ? [] : supply.filter((s) => s.remaining > 0) };
}

export async function getPartDemandStatus(partNumber) {
  const azurePool = await getPool();
  const mgfoPool = await getMgfoPool();

  const header = await getPartHeader(azurePool, partNumber);
  const productIds = await resolveProductIds(mgfoPool, partNumber);
  if (!productIds.length) {
    return { header, allocation: [], availableSupply: [], blockedInventory: [] };
  }

  const [demandLines, poSupplyLines, inventoryLots, blockedInventory, orphans] = await Promise.all([
    getDemandLines(mgfoPool, productIds),
    getSupplyLines(mgfoPool, productIds),
    getInventoryLots(mgfoPool, productIds),
    getBlockedInventoryLots(mgfoPool, productIds),
    getOrphans(mgfoPool, productIds),
  ]);

  const { rows: allocationRows, remainingSupply } = allocate(demandLines, [...inventoryLots, ...poSupplyLines]);
  const availableSupply = remainingSupply
    .filter((s) => s.source === "Inventory")
    .map(({ rev, remaining, reference, location, pedigree }) => ({
      rev,
      quantity: remaining,
      reference,
      location,
      pedigree,
    }));

  // MRP-flagged orphans (never pegged to any demand, regardless of whether
  // this part has other open demand) are just supply with no demand side —
  // shown as their own rows here instead of a separate table.
  const orphanRows = orphans.map((o) => ({
    demand: { needDate: null, rev: null, pedigree: null, quantity: 0 },
    supply: {
      estimatedCompletionDate: o.estimatedCompletionDate,
      rev: o.rev,
      fulfilledBy: ORPHAN_FULFILLED_BY_LABEL[o.type] || o.type,
      reference: o.reference,
      location: o.location,
      pedigree: o.pedigree,
      quantity: o.quantity,
      occurrences: o.occurrences,
    },
  }));

  return {
    header,
    allocation: [...allocationRows, ...orphanRows],
    availableSupply,
    blockedInventory,
  };
}
