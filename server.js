import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { loadSnapshot } from "./src/services/snapshotStore.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (req, res) => res.json({ ok: true }));

// DATA_SOURCE=snapshot (used in Azure, which can't reach Teamcenter or the
// Manufacturo/Jira firewall-allowed IP directly) reads pre-computed JSON blobs
// that refresh/snapshot-refresh.mjs uploads from on-prem. DATA_SOURCE=live
// (the default, used on-prem) queries the real sources directly, same as before.
const USE_SNAPSHOT = process.env.DATA_SOURCE === "snapshot";

function wrap(liveHandler, blobName) {
  return async (req, res) => {
    try {
      const data = USE_SNAPSHOT ? await loadSnapshot(blobName) : await liveHandler();
      res.json(data);
    } catch (err) {
      console.error(`[${req.path}]`, err.message);
      res.status(500).json({ error: "Failed to load metric", detail: err.message });
    }
  };
}

// Live services are only imported when actually needed, so the Azure image
// doesn't need working Teamcenter/Jira/Manufacturo network access to boot.
async function liveOpsPastDue() {
  const { getPastDuePOs } = await import("./src/services/opsMetrics.js");
  return getPastDuePOs();
}
async function liveJiraIssues() {
  const { getOpenIssuesByProject } = await import("./src/services/jiraService.js");
  return getOpenIssuesByProject();
}
async function liveThreeWayMatch() {
  const { getThreeWayMatchSummary } = await import("./src/services/financeMetrics.js");
  return getThreeWayMatchSummary();
}
async function liveReleaseStatus() {
  const { getPartReleaseStatus } = await import("./src/services/engineeringMetrics.js");
  return getPartReleaseStatus();
}
async function liveSafetyOverview() {
  const { getSafetyOverview } = await import("./src/services/safetyMetrics.js");
  return getSafetyOverview();
}

app.get("/api/metrics/ops/pos-past-due", wrap(liveOpsPastDue, "ops-pos-past-due.json"));
app.get("/api/metrics/ops/jira-open-issues", wrap(liveJiraIssues, "ops-jira-open-issues.json"));
app.get("/api/metrics/finance/three-way-match", wrap(liveThreeWayMatch, "finance-three-way-match.json"));
app.get("/api/metrics/engineering/release-status", wrap(liveReleaseStatus, "engineering-release-status.json"));
app.get("/api/metrics/safety/overview", wrap(liveSafetyOverview, "safety-overview.json"));

// Parameterized by part number, so it can't be precomputed into a snapshot blob
// like the metrics above — always queries MFGO_DB live. MFGO_DB is an Azure SQL
// public endpoint (unlike on-prem Teamcenter or the Jira-allowlisted IP), so this
// is reachable the same way whether the app is running on-prem or in Azure.
app.get("/api/metrics/engineering/part-demand-status", async (req, res) => {
  const partNumber = (req.query.partNumber || "").trim();
  if (!partNumber) {
    return res.status(400).json({ error: "partNumber query parameter is required" });
  }
  try {
    const { getPartDemandStatus } = await import("./src/services/partDemandStatus.js");
    const data = await getPartDemandStatus(partNumber);
    res.json(data);
  } catch (err) {
    console.error(`[${req.path}]`, err.message);
    res.status(500).json({ error: "Failed to load part demand status", detail: err.message });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 4100;
app.listen(PORT, () => {
  console.log(`Business metrics dashboard listening on :${PORT} (DATA_SOURCE=${USE_SNAPSHOT ? "snapshot" : "live"})`);
});
