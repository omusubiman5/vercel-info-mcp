#!/usr/bin/env node
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as cheerio from "cheerio";
import fetch, { RequestInit } from "node-fetch";

type IncidentRecord = {
    title: string;
    status: string;
    timestamp: string;
    updates: string[];
    url?: string;
};

type ArticleRecord = {
    title: string;
    url?: string;
    excerpt: string;
    date: string;
};

type CustomerRecord = {
    company: string;
    description: string;
    url?: string;
    logo?: string;
};

type ProjectSummary = {
    id?: string;
    name?: string;
    framework?: string;
    nodeVersion?: string;
    installCommand?: string | null;
    buildCommand?: string | null;
    outputDirectory?: string | null;
    serverlessFunctionRegion?: string | null;
    functionDefaultRegions?: string[];
    fluid?: boolean;
    productionBranch?: string;
    updatedAt?: string;
};

type DeploymentSummary = {
    id?: string;
    name?: string;
    url?: string;
    target?: string | null;
    state?: string;
    createdAt?: string;
    readyAt?: string;
    creator?: string;
    inspectorUrl?: string;
    meta?: Record<string, unknown>;
};

type LogRecord = {
    timestamp?: string;
    level?: string;
    type?: string;
    message: string;
    requestPath?: string;
    route?: string;
    statusCode?: number;
    region?: string;
};

const execAsync = promisify(exec);
const VERCEL_API_BASE = "https://api.vercel.com";
const API_TIMEOUT_MS = 25000;

const server = new Server(
    {
        name: "vercel-info-mcp",
        version: "1.1.0",
    },
    {
        capabilities: {
            tools: {},
        },
    }
);

const REQUEST_HEADERS = {
    "user-agent": "vercel-info-mcp/1.1",
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

async function fetchText(url: string): Promise<string> {
    const response = await fetch(url, { headers: REQUEST_HEADERS });

    if (!response.ok) {
        throw new Error(`Request failed: ${response.status} ${response.statusText}`);
    }

    return response.text();
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
    const response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    const text = await response.text();

    if (!response.ok) {
        throw new Error(`Request failed: ${response.status} ${response.statusText} ${buildExcerpt(text, 400)}`);
    }

    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

function normalizeWhitespace(value: string): string {
    return value.replace(/\s+/g, " ").trim();
}

function decodeEscapedValue(value?: string): string | undefined {
    if (!value || value === "$undefined") {
        return undefined;
    }

    try {
        return JSON.parse(`"${value.replace(/"/g, '\\"')}"`);
    } catch {
        return value;
    }
}

function humanizeSlug(value?: string): string | undefined {
    if (!value) {
        return undefined;
    }

    return value
        .split("-")
        .filter(Boolean)
        .map((part) => (part.length <= 3 ? part.toUpperCase() : part[0].toUpperCase() + part.slice(1)))
        .join(" ");
}

function normalizeCompanyName(value?: string): string | undefined {
    if (!value) {
        return undefined;
    }

    const cleaned = normalizeWhitespace(value.replace(/\s+logo$/i, ""));

    if (/^[a-z0-9-]+$/i.test(cleaned)) {
        return humanizeSlug(cleaned);
    }

    return cleaned;
}

function companyKey(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function toAbsoluteUrl(url: string | undefined, base: string): string | undefined {
    if (!url || url === "$undefined") {
        return undefined;
    }

    if (url.startsWith("http://") || url.startsWith("https://")) {
        return url;
    }

    return new URL(url, base).toString();
}

function buildExcerpt(value: string, maxLength = 280): string {
    const normalized = normalizeWhitespace(value);

    if (normalized.length <= maxLength) {
        return normalized;
    }

    return `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
}

function normalizeTimestamp(value: unknown): string | undefined {
    if (typeof value === "number" && Number.isFinite(value)) {
        return new Date(value).toISOString();
    }

    if (typeof value !== "string" || !value.trim()) {
        return undefined;
    }

    const numeric = Number(value);

    if (Number.isFinite(numeric) && /^\d+$/.test(value)) {
        return new Date(numeric).toISOString();
    }

    const parsed = new Date(value);

    if (Number.isNaN(parsed.valueOf())) {
        return value;
    }

    return parsed.toISOString();
}

function parseTimeInput(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }

    if (typeof value !== "string" || !value.trim()) {
        return undefined;
    }

    const numeric = Number(value);

    if (Number.isFinite(numeric) && /^\d+$/.test(value.trim())) {
        return numeric;
    }

    const parsed = new Date(value);

    if (Number.isNaN(parsed.valueOf())) {
        return undefined;
    }

    return parsed.valueOf();
}

function extractCustomerCards(html: string): CustomerRecord[] {
    const $ = cheerio.load(html);
    const seen = new Set<string>();
    const cards: CustomerRecord[] = [];

    $('a[href^="/customers/"]').each((_, element) => {
        const href = $(element).attr("href");
        const logoAlt = $(element).find("img").first().attr("alt");
        const heading = $(element).find("h2, h3, h4").first().text();
        const description = $(element).find("p").first().text();
        const company = normalizeCompanyName(heading || logoAlt || "");

        if (!href || !company) {
            return;
        }

        const url = toAbsoluteUrl(href, "https://vercel.com");
        const key = `${companyKey(company)}::${url ?? ""}`;

        if (seen.has(key)) {
            return;
        }

        seen.add(key);
        cards.push({
            company,
            description: normalizeWhitespace(description),
            url,
            logo: logoAlt,
        });
    });

    return cards;
}

function extractEmbeddedCustomers(html: string): CustomerRecord[] {
    const customers: CustomerRecord[] = [];
    const seen = new Set<string>();
    const recordStart = '{\\"logo\\":\\"';
    let cursor = 0;

    while (cursor < html.length) {
        const start = html.indexOf(recordStart, cursor);

        if (start === -1) {
            break;
        }

        const draftIndex = html.indexOf('\\"isDraft\\":', start);
        const end = draftIndex === -1 ? -1 : html.indexOf("}", draftIndex);

        if (draftIndex === -1 || end === -1) {
            break;
        }

        const record = html.slice(start, end + 1);
        cursor = end + 1;

        const logo = decodeEscapedValue(record.match(/\\"logo\\":\\"([^\\"]+)\\"/)?.[1]);
        const companyName = decodeEscapedValue(
            record.match(/\\"companyName\\":\\"([^\\"]*)\\"/)?.[1]
        );
        const displayName = decodeEscapedValue(record.match(/\\"name\\":\\"([^\\"]*)\\"/)?.[1]);
        const storyHref = decodeEscapedValue(
            record.match(/\\"storyHref\\":\\"([^\\"]*)\\"/)?.[1]
        );
        const siteHref = decodeEscapedValue(
            record.match(/\\"siteHref\\":\\"([^\\"]*)\\"/)?.[1]
        );
        const industriesRaw = record.match(/\\"industries\\":\[(.*?)\]/)?.[1] ?? "";
        const industries = Array.from(industriesRaw.matchAll(/\\"([^\\"]+)\\"/g))
            .map((match) => decodeEscapedValue(match[1]))
            .filter((value): value is string => Boolean(value));
        const company = normalizeCompanyName(companyName || displayName || logo);

        if (!company) {
            continue;
        }

        const url = toAbsoluteUrl(storyHref || siteHref, "https://vercel.com");
        const description = industries.join(", ");
        const key = `${companyKey(company)}::${url ?? ""}`;

        if (seen.has(key)) {
            continue;
        }

        seen.add(key);
        customers.push({
            company,
            description,
            url,
            logo,
        });
    }

    return customers;
}

function mergeCustomers(primary: CustomerRecord[], secondary: CustomerRecord[]): CustomerRecord[] {
    const merged = new Map<string, CustomerRecord>();

    for (const item of [...primary, ...secondary]) {
        const key = companyKey(item.company);
        const existing = merged.get(key);

        if (!existing) {
            merged.set(key, item);
            continue;
        }

        merged.set(key, {
            company: existing.company,
            description: existing.description || item.description,
            url: existing.url || item.url,
            logo: existing.logo || item.logo,
        });
    }

    return Array.from(merged.values()).sort((a, b) => a.company.localeCompare(b.company));
}

function getVercelToken(): string | undefined {
    return process.env.VERCEL_TOKEN || process.env.VERCEL_ACCESS_TOKEN;
}

function getVercelScope(): string | undefined {
    return process.env.VERCEL_SCOPE || process.env.VERCEL_TEAM_SLUG;
}

function buildVercelApiPath(path: string, params?: Record<string, unknown>): string {
    const url = new URL(path.startsWith("/") ? path : `/${path}`, VERCEL_API_BASE);
    const teamId = process.env.VERCEL_TEAM_ID;

    if (teamId && !url.searchParams.has("teamId")) {
        url.searchParams.set("teamId", teamId);
    }

    for (const [key, value] of Object.entries(params ?? {})) {
        if (value === undefined || value === null || value === "") {
            continue;
        }

        url.searchParams.set(key, String(value));
    }

    return `${url.pathname}${url.search}`;
}

async function requestVercelApi(path: string, params?: Record<string, unknown>): Promise<unknown> {
    const apiPath = buildVercelApiPath(path, params);
    const token = getVercelToken();

    if (token) {
        return fetchJson(`${VERCEL_API_BASE}${apiPath}`, {
            headers: {
                authorization: `Bearer ${token}`,
                accept: "application/json",
            },
        });
    }

    return requestVercelApiViaCli(apiPath);
}

async function requestVercelApiViaCli(apiPath: string): Promise<unknown> {
    const scope = getVercelScope();
    const scopeArg = scope ? ` --scope "${scope.replace(/"/g, '\\"')}"` : "";
    const command = `vercel api "${apiPath.replace(/"/g, '\\"')}" --raw${scopeArg}`;

    try {
        const { stdout } = await execAsync(command, {
            maxBuffer: 20 * 1024 * 1024,
            timeout: API_TIMEOUT_MS,
        });

        const trimmed = stdout.trim();

        try {
            return JSON.parse(trimmed);
        } catch {
            return trimmed;
        }
    } catch (error: unknown) {
        const details = error instanceof Error ? error.message : String(error);
        throw new Error(
            `Vercel API request failed. Set VERCEL_TOKEN or ensure 'vercel api' works locally. ${buildExcerpt(details, 400)}`
        );
    }
}

function summarizeProject(project: any): ProjectSummary {
    return {
        id: project?.id,
        name: project?.name,
        framework: project?.framework,
        nodeVersion: project?.nodeVersion,
        installCommand: project?.installCommand ?? null,
        buildCommand: project?.buildCommand ?? null,
        outputDirectory: project?.outputDirectory ?? null,
        serverlessFunctionRegion: project?.serverlessFunctionRegion ?? null,
        functionDefaultRegions:
            project?.resourceConfig?.functionDefaultRegions ??
            project?.defaultResourceConfig?.functionDefaultRegions ??
            [],
        fluid:
            project?.resourceConfig?.fluid ??
            project?.defaultResourceConfig?.fluid ??
            false,
        productionBranch: project?.link?.productionBranch,
        updatedAt: normalizeTimestamp(project?.updatedAt),
    };
}

function summarizeDeployment(deployment: any): DeploymentSummary {
    return {
        id: deployment?.id,
        name: deployment?.name,
        url: deployment?.url ? `https://${deployment.url}` : undefined,
        target: deployment?.target ?? null,
        state: deployment?.readyState || deployment?.state,
        createdAt: normalizeTimestamp(deployment?.createdAt),
        readyAt: normalizeTimestamp(deployment?.readyAt),
        creator:
            deployment?.creator?.username ||
            deployment?.creator?.githubLogin ||
            deployment?.creator?.email,
        inspectorUrl: deployment?.inspectorUrl,
        meta: deployment?.meta,
    };
}

function coerceArray<T>(value: unknown, candidates: string[] = []): T[] {
    if (Array.isArray(value)) {
        return value as T[];
    }

    if (value && typeof value === "object") {
        for (const key of candidates) {
            const nested = (value as Record<string, unknown>)[key];

            if (Array.isArray(nested)) {
                return nested as T[];
            }
        }
    }

    return [];
}

function extractEventMessage(event: any): string {
    const directCandidates = [
        event?.text,
        event?.message,
        event?.payload?.text,
        event?.payload?.message,
        event?.payload?.name,
        event?.info?.message,
    ]
        .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
        .map((value) => normalizeWhitespace(value));

    if (directCandidates.length > 0) {
        return directCandidates[0];
    }

    if (event?.payload && typeof event.payload === "object") {
        return buildExcerpt(JSON.stringify(event.payload), 400);
    }

    return buildExcerpt(JSON.stringify(event), 400);
}

function mapBuildLogRecord(event: any): LogRecord {
    return {
        timestamp: normalizeTimestamp(event?.created || event?.createdAt || event?.date),
        level: typeof event?.info === "string" ? event.info : undefined,
        type: event?.type || event?.payload?.type,
        message: extractEventMessage(event),
        route: event?.payload?.route,
        region: event?.payload?.region,
    };
}

function parseStructuredTextLines(raw: string): any[] {
    return raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
            try {
                return JSON.parse(line);
            } catch {
                return { message: line };
            }
        });
}

function mapRuntimeLogRecord(entry: any): LogRecord {
    return {
        timestamp: normalizeTimestamp(
            entry?.timestamp ||
                entry?.createdAt ||
                entry?.time ||
                entry?.date
        ),
        level:
            entry?.level ||
            entry?.severity ||
            entry?.source,
        type: entry?.type,
        message: extractEventMessage(entry),
        requestPath: entry?.requestPath || entry?.path,
        route: entry?.route,
        statusCode: typeof entry?.statusCode === "number" ? entry.statusCode : undefined,
        region: entry?.region || entry?.edgeRegion || entry?.executionRegion,
    };
}

async function resolveProject(projectIdOrName: string): Promise<any> {
    return requestVercelApi(`/v9/projects/${encodeURIComponent(projectIdOrName)}`);
}

async function resolveDeployment(deploymentIdOrUrl: string): Promise<any> {
    return requestVercelApi(`/v13/deployments/${encodeURIComponent(deploymentIdOrUrl)}`);
}

async function getIncidentHistory() {
    try {
        const xml = await fetchText("https://www.vercel-status.com/history.rss");
        const $ = cheerio.load(xml, { xmlMode: true });
        const incidents: IncidentRecord[] = [];

        $("item").each((_, item) => {
            const title = normalizeWhitespace($(item).find("title").first().text());
            const timestamp = normalizeWhitespace($(item).find("pubDate").first().text());
            const url = normalizeWhitespace($(item).find("link").first().text()) || undefined;
            const descriptionHtml = $(item).find("description").first().text();
            const description = cheerio.load(descriptionHtml);
            let status = "";
            const updates = description("p")
                .map((__, paragraph) => {
                    const node = description(paragraph);
                    const updateStatus = normalizeWhitespace(node.find("strong").first().text());
                    const updateTimestamp = normalizeWhitespace(node.find("small").first().text());
                    let updateBody = normalizeWhitespace(node.find("span").text() || node.text());

                    if (updateTimestamp) {
                        updateBody = normalizeWhitespace(updateBody.replace(updateTimestamp, ""));
                    }

                    if (updateStatus) {
                        updateBody = normalizeWhitespace(updateBody.replace(updateStatus, ""));
                    }

                    updateBody = updateBody.replace(/^\s*-\s*/, "");

                    if (!status && updateStatus) {
                        status = updateStatus;
                    }

                    return [updateTimestamp, updateStatus && `${updateStatus} -`, updateBody]
                        .filter(Boolean)
                        .join(" ");
                })
                .get()
                .filter(Boolean);

            if (!title) {
                return;
            }

            incidents.push({
                title,
                status,
                timestamp,
                updates,
                url,
            });
        });

        return {
            success: true,
            incidents,
            totalCount: incidents.length,
        };
    } catch (error: any) {
        return {
            success: false,
            error: error.message,
        };
    }
}

async function getPostmortemArticles(query = "incident") {
    try {
        const xml = await fetchText("https://vercel.com/atom");
        const $ = cheerio.load(xml, { xmlMode: true });
        const normalizedQuery = query.trim().toLowerCase();
        const relatedTerms =
            normalizedQuery === "incident"
                ? ["incident", "incidents", "outage", "outages", "postmortem", "downtime", "service disruption"]
                : normalizedQuery.split(/\s+/).filter(Boolean);
        const articles: ArticleRecord[] = [];

        $("entry").each((_, entry) => {
            const title = normalizeWhitespace($(entry).find("title").first().text());
            const url = $(entry).find("link").first().attr("href");
            const date = normalizeWhitespace($(entry).find("updated").first().text());
            const rawContent = $(entry).find("content").text();
            const excerpt = buildExcerpt(rawContent);
            const titleAndUrl = `${title}\n${url ?? ""}`.toLowerCase();
            const isIncidentLike =
                relatedTerms.some((term) => titleAndUrl.includes(term)) ||
                /update regarding .*service disruption/i.test(title) ||
                /service disruption/i.test(excerpt);

            if (!title || !isIncidentLike) {
                return;
            }

            articles.push({
                title,
                url,
                excerpt,
                date,
            });
        });

        return {
            success: true,
            articles,
            totalCount: articles.length,
            query,
        };
    } catch (error: any) {
        return {
            success: false,
            error: error.message,
        };
    }
}

async function getCustomerCases(filter?: string) {
    try {
        const html = await fetchText("https://vercel.com/customers");
        const filterValue = filter?.trim().toLowerCase();
        const cases = mergeCustomers(
            extractCustomerCards(html),
            extractEmbeddedCustomers(html)
        ).filter((item) => {
            if (!filterValue) {
                return true;
            }

            const haystack = `${item.company}\n${item.description}\n${item.url ?? ""}`.toLowerCase();
            return haystack.includes(filterValue);
        });

        return {
            success: true,
            cases,
            totalCount: cases.length,
            filter: filter || "none",
        };
    } catch (error: any) {
        return {
            success: false,
            error: error.message,
        };
    }
}

async function getProjectDetails(projectIdOrName: string) {
    try {
        const project = await resolveProject(projectIdOrName);

        return {
            success: true,
            project: summarizeProject(project),
            latestDeploymentIds: coerceArray<any>((project as any)?.latestDeployments).map(
                (deployment) => deployment?.id
            ),
        };
    } catch (error: any) {
        return {
            success: false,
            error: error.message,
        };
    }
}

async function listProjectDeployments(
    projectIdOrName: string,
    limit = 10,
    target?: string,
    state?: string
) {
    try {
        const project = await resolveProject(projectIdOrName);
        const deploymentsResponse = await requestVercelApi("/v6/deployments", {
            projectId: (project as any)?.id,
            limit: clamp(limit, 1, 50),
            target,
            state,
        });
        const deployments = coerceArray<any>(deploymentsResponse, ["deployments"]).map(summarizeDeployment);

        return {
            success: true,
            project: summarizeProject(project),
            deployments,
            totalCount: deployments.length,
        };
    } catch (error: any) {
        return {
            success: false,
            error: error.message,
        };
    }
}

async function getDeploymentBuildLogs(deploymentIdOrUrl: string, limit = 200) {
    try {
        const deployment = await resolveDeployment(deploymentIdOrUrl);
        const deploymentId = (deployment as any)?.id || deploymentIdOrUrl;
        const eventsResponse = await requestVercelApi(
            `/v3/deployments/${encodeURIComponent(deploymentId)}/events`
        );
        const events = coerceArray<any>(eventsResponse, ["events"]);
        const lines = events.slice(0, clamp(limit, 1, 500)).map(mapBuildLogRecord);

        return {
            success: true,
            deployment: summarizeDeployment(deployment),
            totalCount: events.length,
            lines,
        };
    } catch (error: any) {
        return {
            success: false,
            error: error.message,
        };
    }
}

async function getDeploymentRuntimeLogs(
    projectIdOrName: string,
    deploymentIdOrUrl: string,
    limit = 50,
    since?: unknown,
    until?: unknown
) {
    try {
        const project = await resolveProject(projectIdOrName);
        const deployment = await resolveDeployment(deploymentIdOrUrl);
        const projectId = (project as any)?.id || projectIdOrName;
        const deploymentId = (deployment as any)?.id || deploymentIdOrUrl;
        const response = await requestVercelApi(
            `/v1/projects/${encodeURIComponent(projectId)}/deployments/${encodeURIComponent(deploymentId)}/runtime-logs`,
            {
                limit: clamp(limit, 1, 200),
                since: parseTimeInput(since),
                until: parseTimeInput(until),
            }
        );

        const rawEntries =
            typeof response === "string"
                ? parseStructuredTextLines(response)
                : coerceArray<any>(response, ["data", "logs", "entries"]);
        const entries = rawEntries.map(mapRuntimeLogRecord);

        return {
            success: true,
            project: summarizeProject(project),
            deployment: summarizeDeployment(deployment),
            totalCount: entries.length,
            entries,
        };
    } catch (error: any) {
        return {
            success: false,
            error: error.message,
        };
    }
}

server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: "get_vercel_incidents",
                description: "Fetch recent incidents from the Vercel Status history feed.",
                inputSchema: {
                    type: "object",
                    properties: {},
                },
            },
            {
                name: "search_vercel_postmortems",
                description: "Search incident-like posts from the Vercel Atom feed.",
                inputSchema: {
                    type: "object",
                    properties: {
                        query: {
                            type: "string",
                            description: "Query term used to filter incident-like posts.",
                            default: "incident",
                        },
                    },
                },
            },
            {
                name: "get_vercel_customers",
                description: "Fetch Vercel customer case studies with an optional text filter.",
                inputSchema: {
                    type: "object",
                    properties: {
                        filter: {
                            type: "string",
                            description: "Optional company name or text filter.",
                        },
                    },
                },
            },
            {
                name: "get_vercel_project_details",
                description: "Read authenticated Vercel project details from the Vercel API.",
                inputSchema: {
                    type: "object",
                    properties: {
                        projectIdOrName: {
                            type: "string",
                            description: "Project ID or project name.",
                        },
                    },
                    required: ["projectIdOrName"],
                },
            },
            {
                name: "list_vercel_deployments",
                description: "List authenticated Vercel deployments for a project.",
                inputSchema: {
                    type: "object",
                    properties: {
                        projectIdOrName: {
                            type: "string",
                            description: "Project ID or project name.",
                        },
                        limit: {
                            type: "number",
                            description: "Maximum number of deployments to return.",
                            default: 10,
                        },
                        target: {
                            type: "string",
                            description: "Optional deployment target such as production or preview.",
                        },
                        state: {
                            type: "string",
                            description: "Optional deployment state filter.",
                        },
                    },
                    required: ["projectIdOrName"],
                },
            },
            {
                name: "get_vercel_deployment_build_logs",
                description: "Fetch deployment build events from the Vercel API.",
                inputSchema: {
                    type: "object",
                    properties: {
                        deploymentIdOrUrl: {
                            type: "string",
                            description: "Deployment ID or deployment URL.",
                        },
                        limit: {
                            type: "number",
                            description: "Maximum number of log lines to return.",
                            default: 200,
                        },
                    },
                    required: ["deploymentIdOrUrl"],
                },
            },
            {
                name: "get_vercel_runtime_logs",
                description: "Fetch runtime logs for a deployment from the Vercel API.",
                inputSchema: {
                    type: "object",
                    properties: {
                        projectIdOrName: {
                            type: "string",
                            description: "Project ID or project name.",
                        },
                        deploymentIdOrUrl: {
                            type: "string",
                            description: "Deployment ID or deployment URL.",
                        },
                        limit: {
                            type: "number",
                            description: "Maximum number of runtime log entries to return.",
                            default: 50,
                        },
                        since: {
                            type: "string",
                            description: "Optional start time as ISO string or Unix milliseconds.",
                        },
                        until: {
                            type: "string",
                            description: "Optional end time as ISO string or Unix milliseconds.",
                        },
                    },
                    required: ["projectIdOrName", "deploymentIdOrUrl"],
                },
            },
        ],
    };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
        const { name, arguments: args } = request.params;

        switch (name) {
            case "get_vercel_incidents": {
                const result = await getIncidentHistory();
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(result, null, 2),
                        },
                    ],
                };
            }

            case "search_vercel_postmortems": {
                const query = (args as any)?.query || "incident";
                const result = await getPostmortemArticles(query);
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(result, null, 2),
                        },
                    ],
                };
            }

            case "get_vercel_customers": {
                const filter = (args as any)?.filter;
                const result = await getCustomerCases(filter);
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(result, null, 2),
                        },
                    ],
                };
            }

            case "get_vercel_project_details": {
                const projectIdOrName = (args as any)?.projectIdOrName;
                const result = await getProjectDetails(projectIdOrName);
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(result, null, 2),
                        },
                    ],
                };
            }

            case "list_vercel_deployments": {
                const projectIdOrName = (args as any)?.projectIdOrName;
                const limit = Number((args as any)?.limit ?? 10);
                const target = (args as any)?.target;
                const state = (args as any)?.state;
                const result = await listProjectDeployments(projectIdOrName, limit, target, state);
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(result, null, 2),
                        },
                    ],
                };
            }

            case "get_vercel_deployment_build_logs": {
                const deploymentIdOrUrl = (args as any)?.deploymentIdOrUrl;
                const limit = Number((args as any)?.limit ?? 200);
                const result = await getDeploymentBuildLogs(deploymentIdOrUrl, limit);
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(result, null, 2),
                        },
                    ],
                };
            }

            case "get_vercel_runtime_logs": {
                const projectIdOrName = (args as any)?.projectIdOrName;
                const deploymentIdOrUrl = (args as any)?.deploymentIdOrUrl;
                const limit = Number((args as any)?.limit ?? 50);
                const since = (args as any)?.since;
                const until = (args as any)?.until;
                const result = await getDeploymentRuntimeLogs(
                    projectIdOrName,
                    deploymentIdOrUrl,
                    limit,
                    since,
                    until
                );
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(result, null, 2),
                        },
                    ],
                };
            }

            default:
                throw new Error(`Unknown tool: ${name}`);
        }
    } catch (error: any) {
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({ error: error.message }),
                },
            ],
            isError: true,
        };
    }
});

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Vercel Info MCP Server running on stdio");
}

main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
});
