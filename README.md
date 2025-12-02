# Bloom Energy (BE) Real-Time Impact Alert Monitor

Get instant email alerts when:
- Executives sell/buy shares
- Earnings or material 8-K/10-Q filed
- Major news about travel, meetings, partnerships
- Stock moves >5% in a day

Uses free APIs: NewsAPI, Alpha Vantage, SEC EDGAR.

## Setup
1. `npm install`
2. Copy `.env.example` → `.env` and fill your keys
3. `npm run monitor`

Schedule with cron (recommended):
```bash
0 * * * * cd /path/to/be-alert-monitor && node index.js >> log.txt 2>&1