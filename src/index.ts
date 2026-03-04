#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import fetch from "node-fetch";
import * as cheerio from "cheerio";

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

const server = new Server(
    {
        name: "vercel-info-mcp",
        version: "1.0.0",
    },
    {
        capabilities: {
            tools: {},
        },
    }
);

const REQUEST_HEADERS = {
    "user-agent": "vercel-info-mcp/1.0",
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

async function fetchText(url: string): Promise<string> {
    const response = await fetch(url, { headers: REQUEST_HEADERS });

    if (!response.ok) {
        throw new Error(`Request failed: ${response.status} ${response.statusText}`);
    }

    return response.text();
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

async function getPostmortemArticles(query: string = "incident") {
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

server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: "get_vercel_incidents",
                description:
                    "Vercel Status の incident history feed から最近の障害履歴を取得します。",
                inputSchema: {
                    type: "object",
                    properties: {},
                },
            },
            {
                name: "search_vercel_postmortems",
                description:
                    "Vercel の Atom feed を検索し、incident / outage / postmortem 関連の記事を返します。",
                inputSchema: {
                    type: "object",
                    properties: {
                        query: {
                            type: "string",
                            description:
                                "検索キーワード。デフォルトは 'incident' で、関連語も含めて絞り込みます。",
                            default: "incident",
                        },
                    },
                },
            },
            {
                name: "get_vercel_customers",
                description:
                    "Vercel Customers ページから顧客事例と掲載企業を取得します。企業名で絞り込みできます。",
                inputSchema: {
                    type: "object",
                    properties: {
                        filter: {
                            type: "string",
                            description: "企業名や業種の部分一致フィルタ。",
                        },
                    },
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
