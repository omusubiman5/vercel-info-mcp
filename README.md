# Vercel Info MCP Server

MCP server for reading public Vercel status/content plus authenticated Vercel project, deployment, and log data.

## Features

- Public incident history from `vercel-status.com`
- Incident-like posts from the Vercel Atom feed
- Customer case studies from `vercel.com/customers`
- Authenticated project details from the Vercel API
- Authenticated deployment lists from the Vercel API
- Authenticated build logs and runtime logs from the Vercel API

## Install

```bash
npm install
npm run build
```

## Requirements

- Node.js 18 or newer
- For authenticated tools, either:
  - a Vercel access token, or
  - the Vercel CLI installed and already authenticated

## Authentication

Authenticated tools use one of these methods:

1. `VERCEL_TOKEN` or `VERCEL_ACCESS_TOKEN`
2. Fallback to `vercel api ...` through the Vercel CLI if you are already logged in

Optional scope variables:

- `VERCEL_SCOPE` or `VERCEL_TEAM_SLUG`
- `VERCEL_TEAM_ID`

## Claude Desktop

```json
{
  "mcpServers": {
    "vercel-info": {
      "command": "node",
      "args": ["/path/to/vercel-info-mcp/build/index.js"],
      "env": {
        "VERCEL_TOKEN": "your-token",
        "VERCEL_SCOPE": "your-team-slug"
      }
    }
  }
}
```

If you prefer CLI auth, omit `VERCEL_TOKEN` and make sure `vercel api /v2/user` works in the same environment.

## Tools

### Public tools

- `get_vercel_incidents`
- `search_vercel_postmortems`
- `get_vercel_customers`

### Authenticated tools

- `get_vercel_project_details`
- `list_vercel_deployments`
- `get_vercel_deployment_build_logs`
- `get_vercel_runtime_logs`

## Example usage

### Inspect a project

```json
{
  "projectIdOrName": "ai-diagnosis-service"
}
```

Returns a normalized summary including:

- project id and name
- framework
- Node.js version
- install/build command
- effective function region
- default function regions
- Fluid setting

### List recent deployments

```json
{
  "projectIdOrName": "ai-diagnosis-service",
  "limit": 5,
  "target": "production"
}
```

### Read build logs

```json
{
  "deploymentIdOrUrl": "dpl_2djLrbXfzUHPoutM6B2dCJmJhSkj",
  "limit": 50
}
```

### Read runtime logs

```json
{
  "projectIdOrName": "ai-diagnosis-service",
  "deploymentIdOrUrl": "dpl_2djLrbXfzUHPoutM6B2dCJmJhSkj",
  "limit": 20,
  "since": "2026-03-04T08:00:00.000Z"
}
```

## Notes

- Public tools do not require authentication.
- Authenticated tools first try `VERCEL_TOKEN` / `VERCEL_ACCESS_TOKEN`. If not present, they fall back to `vercel api ...`.
- `get_vercel_project_details` intentionally returns a normalized summary rather than the full raw project payload.
- `get_vercel_runtime_logs` accepts optional `since` and `until` values as ISO timestamps or Unix milliseconds.
- `get_vercel_deployment_build_logs` uses deployment events from the Vercel API.
- Runtime log responses can be slow depending on the deployment and region. The MCP applies an internal API timeout to avoid hanging indefinitely.

## License

MIT
