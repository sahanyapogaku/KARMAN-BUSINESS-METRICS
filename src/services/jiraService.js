const BASE_URL = process.env.JIRA_BASE_URL;

function authHeader() {
  const creds = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString("base64");
  return `Basic ${creds}`;
}

async function jiraFetch(path, options = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: { Authorization: authHeader(), Accept: "application/json", "Content-Type": "application/json", ...options.headers },
  });
  if (!res.ok) throw new Error(`Jira API ${path} -> ${res.status}`);
  return res.json();
}

async function countOpenIssues(projectKey) {
  const data = await jiraFetch("/rest/api/3/search/approximate-count", {
    method: "POST",
    body: JSON.stringify({ jql: `project = ${projectKey} AND statusCategory != Done` }),
  });
  return data.count;
}

export async function getOpenIssuesByProject() {
  const projectData = await jiraFetch("/rest/api/3/project/search?maxResults=100");
  const projects = projectData.values || [];

  const results = [];
  for (const p of projects) {
    const openCount = await countOpenIssues(p.key);
    if (openCount > 0) {
      results.push({ projectKey: p.key, projectName: p.name, openCount });
    }
  }
  results.sort((a, b) => b.openCount - a.openCount);
  return {
    total: results.reduce((sum, r) => sum + r.openCount, 0),
    projects: results,
  };
}
