# Karman Business Metrics Dashboard

This project provides a business metrics dashboard for Karman operations, finance, engineering, and safety data.

## Local setup

1. Install Node.js 20 LTS.
2. From the project root, install dependencies:

```bash
npm install
```

3. Start the app:

```bash
npm start
```

The dashboard will run on port 4100 by default.

## Important notes about git

The repository intentionally does not track generated dependencies or local environment files.

- `node_modules/` is gitignored and should never be pushed to GitHub.
- `.env` is also gitignored and must be supplied separately for local or server deployment.
- Run `npm install` on each machine or deployment target to recreate dependencies locally.

This keeps the repository small and avoids committing large dependency folders or environment secrets.

## Deployment docs

For on-prem Windows Server installation and service setup, see [DEPLOY-ON-PREM.md](./DEPLOY-ON-PREM.md).

## Available endpoints

- `/api/health`
- `/api/metrics/ops/pos-past-due`
- `/api/metrics/ops/jira-open-issues`
- `/api/metrics/finance/three-way-match`
- `/api/metrics/engineering/release-status`
- `/api/metrics/safety/overview`
