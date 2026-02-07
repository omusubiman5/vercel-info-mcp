#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, } from "@modelcontextprotocol/sdk/types.js";
import fetch from "node-fetch";
import * as cheerio from "cheerio";
const server = new Server({
    name: "vercel-info-mcp",
    version: "1.0.0",
}, {
    capabilities: {
        tools: {},
    },
});
// Vercel Status からインシデント履歴を取得
async function getIncidentHistory() {
    try {
        const response = await fetch("https://www.vercel-status.com");
        const html = await response.text();
        const $ = cheerio.load(html);
        const incidents = [];
        // インシデントセクションを抽出
        $(".incident").each((i, elem) => {
            const title = $(elem).find(".incident-title").text().trim();
            const status = $(elem).find(".incident-status").text().trim();
            const timestamp = $(elem).find(".incident-timestamp").text().trim();
            const updates = $(elem)
                .find(".update")
                .map((_, update) => $(update).text().trim())
                .get();
            if (title) {
                incidents.push({
                    title,
                    status,
                    timestamp,
                    updates,
                });
            }
        });
        return {
            success: true,
            incidents,
            totalCount: incidents.length,
        };
    }
    catch (error) {
        return {
            success: false,
            error: error.message,
        };
    }
}
// Vercel Blog から障害レポート・ポストモーテム記事を検索
async function getPostmortemArticles(query = "incident") {
    try {
        const response = await fetch(`https://vercel.com/blog?search=${encodeURIComponent(query)}`);
        const html = await response.text();
        const $ = cheerio.load(html);
        const articles = [];
        // ブログ記事のリストを抽出
        $("article").each((i, elem) => {
            const title = $(elem).find("h2, h3").first().text().trim();
            const link = $(elem).find("a").first().attr("href");
            const excerpt = $(elem).find("p").first().text().trim();
            const date = $(elem)
                .find('time, [datetime], .date, [class*="date"]')
                .first()
                .text()
                .trim();
            if (title && link) {
                articles.push({
                    title,
                    url: link.startsWith("http") ? link : `https://vercel.com${link}`,
                    excerpt,
                    date,
                });
            }
        });
        return {
            success: true,
            articles,
            totalCount: articles.length,
            query,
        };
    }
    catch (error) {
        return {
            success: false,
            error: error.message,
        };
    }
}
// Vercel 顧客事例を取得
async function getCustomerCases(filter) {
    try {
        const response = await fetch("https://vercel.com/customers");
        const html = await response.text();
        const $ = cheerio.load(html);
        const cases = [];
        // 顧客事例のカードやセクションを抽出
        $('[class*="customer"], [class*="case-study"], article').each((i, elem) => {
            const company = $(elem)
                .find("h2, h3, [class*='company'], [class*='title']")
                .first()
                .text()
                .trim();
            const description = $(elem).find("p").first().text().trim();
            const link = $(elem).find("a").first().attr("href");
            const logo = $(elem).find("img").first().attr("src");
            if (company) {
                const caseData = {
                    company,
                    description,
                    url: link?.startsWith("http") ? link : `https://vercel.com${link}`,
                    logo: logo?.startsWith("http") ? logo : logo ? `https://vercel.com${logo}` : undefined,
                };
                // フィルタリング（指定された場合）
                if (!filter || company.toLowerCase().includes(filter.toLowerCase())) {
                    cases.push(caseData);
                }
            }
        });
        return {
            success: true,
            cases,
            totalCount: cases.length,
            filter: filter || "none",
        };
    }
    catch (error) {
        return {
            success: false,
            error: error.message,
        };
    }
}
// ツールの定義
server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: "get_vercel_incidents",
                description: "Vercel Statusページからインシデント履歴を取得します。最近の障害情報や現在進行中の問題を確認できます。",
                inputSchema: {
                    type: "object",
                    properties: {},
                },
            },
            {
                name: "search_vercel_postmortems",
                description: "Vercel公式ブログから障害レポートやポストモーテム記事を検索します。過去のインシデント分析や対応策を学べます。",
                inputSchema: {
                    type: "object",
                    properties: {
                        query: {
                            type: "string",
                            description: "検索キーワード（デフォルト: 'incident'）。'outage', 'postmortem', 'downtime'なども有効です",
                            default: "incident",
                        },
                    },
                },
            },
            {
                name: "get_vercel_customers",
                description: "Vercelの顧客事例を取得します。企業名でフィルタリングも可能です。",
                inputSchema: {
                    type: "object",
                    properties: {
                        filter: {
                            type: "string",
                            description: "企業名でフィルタリング（オプション）。部分一致で検索します",
                        },
                    },
                },
            },
        ],
    };
});
// ツール実行ハンドラ
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
                const query = args?.query || "incident";
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
                const filter = args?.filter;
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
    }
    catch (error) {
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
// サーバー起動
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Vercel Info MCP Server running on stdio");
}
main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
});
