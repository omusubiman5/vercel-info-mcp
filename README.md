# Vercel Info MCP Server

Vercelの各種情報（インシデント履歴、ポストモーテム記事、顧客事例）にアクセスできるMCPサーバーです。

## 機能

- 📊 **インシデント履歴取得**: Vercel Statusページから現在および過去のインシデントを取得
- 📝 **ポストモーテム記事検索**: Vercel公式ブログから障害関連記事を検索
- 🏢 **顧客事例取得**: Vercelを利用している企業の事例を取得

## インストール
```bash
npm install
npm run build
```

## Claude Desktopでの設定

`claude_desktop_config.json`に以下を追加：
```json
{
  "mcpServers": {
    "vercel-info": {
      "command": "node",
      "args": ["/path/to/vercel-info-mcp/build/index.js"]
    }
  }
}
```

## 使用可能なツール

### `get_vercel_incidents`
Vercel Statusページからインシデント履歴を取得

### `search_vercel_postmortems`
Vercel公式ブログから障害レポート・ポストモーテム記事を検索

パラメータ:
- `query` (string, optional): 検索キーワード（デフォルト: "incident"）

### `get_vercel_customers`
Vercelの顧客事例を取得

パラメータ:
- `filter` (string, optional): 企業名でフィルタリング

## ライセンス

MIT