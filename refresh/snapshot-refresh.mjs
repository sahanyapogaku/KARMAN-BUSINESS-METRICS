// Runs on-prem (this machine has direct network access to Teamcenter and the
// Manufacturo-firewall-allowed IP). Pulls each metric live and uploads the
// result as a JSON blob, which the Azure-hosted copy of this app reads
// instead of querying the sources directly (see server.js DATA_SOURCE=snapshot).
//
// Scheduled via Windows Task Scheduler — see ../DEPLOY-ON-PREM.md.

import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";
import { saveSnapshot } from "../src/services/snapshotStore.js";
import { getPastDuePOs } from "../src/services/opsMetrics.js";
import { getOpenIssuesByProject } from "../src/services/jiraService.js";
import { getThreeWayMatchSummary } from "../src/services/financeMetrics.js";
import { getPartReleaseStatus } from "../src/services/engineeringMetrics.js";
import { getSafetyOverview } from "../src/services/safetyMetrics.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const JOBS = [
  { name: "ops-pos-past-due", fn: getPastDuePOs },
  { name: "ops-jira-open-issues", fn: getOpenIssuesByProject },
  { name: "finance-three-way-match", fn: getThreeWayMatchSummary },
  { name: "engineering-release-status", fn: getPartReleaseStatus },
  { name: "safety-overview", fn: getSafetyOverview },
];

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function main() {
  let failures = 0;
  for (const job of JOBS) {
    try {
      log(`Refreshing ${job.name}...`);
      const data = await job.fn();
      await saveSnapshot(`${job.name}.json`, data);
      log(`Uploaded ${job.name}.json`);
    } catch (err) {
      failures++;
      log(`FAILED ${job.name}: ${err.message}`);
    }
  }
  if (failures > 0) {
    log(`Done with ${failures} failure(s).`);
    process.exit(1);
  }
  log("All snapshots refreshed successfully.");
  process.exit(0);
}

main();
