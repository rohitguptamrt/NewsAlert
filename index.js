// index.js - Bloom Energy (BE) Real-Time Impact Alert Monitor
import axios from 'axios';
import cheerio from 'cheerio';
import { parse } from 'node-html-parser';
import dayjs from 'dayjs';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import nodemailer from 'nodemailer';
import vader from 'vader-sentiment';
import 'dotenv/config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TICKER = 'BE';
const STATE_FILE = path.join(__dirname, 'state.json');
const STAKEHOLDERS = ['KR Sridhar', 'Aman Joshi', 'Greg Cameron', 'Ravi Prasher', 'Satish Chitoori'];
const PRICE_THRESHOLD = 5.0; // % change
const SHARE_THRESHOLD = 1000;
const NEWS_KEYWORDS = ['travel', 'meeting', 'partnership', 'opportunity', 'earnings', 'conference', 'data center'];

let transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

async function loadState() {
  try {
    const data = await fs.readFile(STATE_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return { lastCheck: dayjs().subtract(1, 'day').toISOString() };
  }
}

async function saveState() {
  const state = { lastCheck: new Date().toISOString() };
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

async function sendEmail(subject, body) {
  try {
    await transporter.sendMail({
      from: `"BE Alert" <${process.env.EMAIL_FROM}>`,
      to: process.env.EMAIL_TO,
      subject: subject,
      text: body,
    });
    console.log('Email sent:', subject);
  } catch (err) {
    console.error('Email failed:', err.message);
  }
}

// 1. Insider Transactions (Form 4 via SEC EDGAR RSS + parsing)
async function checkInsiderTransactions(lastCheck) {
  const alerts = [];
  const since = dayjs(lastCheck).format('YYYYMMDD');
  const url = `https://www.sec.gov/Archives/edgar/daily-index-rss.xml`;

  try {
    const { data } = await axios.get(url);
    const root = parse(data);
    const items = root.querySelectorAll('item');

    for (const item of items.slice(0, 50)) { // Limit to recent
      const link = item.querySelector('link')?.text;
      const pubDate = item.querySelector('pubDate')?.text;
      if (!link || !link.includes('xbrl')) continue;

      const dateMatch = link.match(/(\d{8})/);
      if (!dateMatch || dateMatch[1] < since) continue;

      if (link.includes('-4-')) {
        const filingResp = await axios.get(link);
        const $ = cheerio.load(filingResp.data);

        const ownerName = $('reportingOwner rptOwnerName').text().trim();
        const transactionText = $('nonDerivativeTransaction transactionAmounts transactionShares value').text();
        const shares = parseInt(transactionText.replace(/[^0-9.-]/g, '')) || 0;
        const isSale = $('transactionCoding transactionFormType').text().includes('4') && shares > 0;

        if (Math.abs(shares) > SHARE_THRESHOLD && STAKEHOLDERS.some(s => ownerName.includes(s))) {
          const type = isSale ? 'Sale' : 'Purchase';
          alerts.push(`INSIDER ${type}: ${ownerName} — ${Math.abs(shares).toLocaleString()} shares (${dayjs(pubDate).format('MMM D')})`);
        }
      }
    }
  } catch (err) {
    console.error('Insider check failed:', err.message);
  }
  return alerts;
}

// 2. Earnings & Material Filings (8-K, 10-Q)
async function checkEarningsFilings(lastCheck) {
  const alerts = [];
  const since = dayjs(lastCheck).format('YYYY-MM-DD');
  const cik = '0001664703'; // Bloom Energy CIK
  const url = `https://data.sec.gov/submissions/CIK${cik}.json`;

  try {
    const { data } = await axios.get(url, {
      headers: { 'User-Agent': 'BE Monitor v1.0 (your.email@example.com)' }
    });

    const filings = data.filings.recent;
    const forms = filings.form;
    const filingDates = filings.filingDate;
    const descriptions = filings.primaryDocDescription || [];

    for (let i = 0; i < forms.length; i++) {
      const date = filingDates[i];
      if (dayjs(date).isBefore(since)) continue;

      if (['8-K', '10-Q'].includes(forms[i])) {
        const desc = descriptions[i] || '';
        if (desc.toLowerCase().includes('earnings') || forms[i] === '10-Q') {
          alerts.push(`FILING: ${forms[i]} filed on ${dayjs(date).format('MMM D')} — ${desc}`);
        }
      }
    }
  } catch (err) {
    console.error('Filings check failed:', err.message);
  }
  return alerts;
}

// 3. News & Events (Travel, Meetings, Opportunities)
async function checkNews(lastCheck) {
  const alerts = [];
  const from = dayjs(lastCheck).format('YYYY-MM-DD');
  const q = `("Bloom Energy" OR BE) (${NEWS_KEYWORDS.map(k => `"${k}"`).join(' OR ')})`;

  const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(q)}&from=${from}&sortBy=publishedAt&apiKey=${process.env.NEWSAPI_KEY}`;

  try {
    const { data } = await axios.get(url);
    for (const article of data.articles.slice(0, 10)) {
      const intensity = vader.SentimentIntensityAnalyzer.polarity_scores(article.title + '. ' + (article.description || ''));
      if (Math.abs(intensity.compound) > 0.3) {
        const sentiment = intensity.compound > 0 ? 'POSITIVE' : 'NEGATIVE';
        alerts.push(`${sentiment} NEWS: ${article.title}\n    → ${article.url}`);
      }
    }
  } catch (err) {
    console.error('News check failed:', err.message);
  }
  return alerts;
}

// 4. Stock Price Movement
async function checkStockPrice() {
  const alerts = [];
  const url = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${TICKER}&apikey=${process.env.ALPHA_VANTAGE_KEY}`;

  try {
    const { data } = await axios.get(url);
    const timeSeries = data['Time Series (Daily)'];
    const dates = Object.keys(timeSeries).sort().reverse();
    const latest = timeSeries[dates[0]];
    const previous = timeSeries[dates[1]];

    const close = parseFloat(latest['4. close']);
    const prevClose = parseFloat(previous['4. close']);
    const changePct = ((close - prevClose) / prevClose) * 100;

    if (Math.abs(changePct) >= PRICE_THRESHOLD) {
      const arrow = changePct > 0 ? '↑' : '↓';
      alerts.push(`PRICE ${arrow} ${changePct.toFixed(2)}% → $${close.toFixed(2)} (as of ${dates[0]})`);
    }
  } catch (err) {
    console.error('Price check failed:', err.message);
  }
  return alerts;
}

// Main Monitor
async function runMonitor() {
  console.log(`\nBloom Energy (BE) Monitor — ${new Date().toLocaleString()}\n`);
  const state = await loadState();
  const alerts = [];

  alerts.push(...await checkInsiderTransactions(state.lastCheck));
  alerts.push(...await checkEarningsFilings(state.lastCheck));
  alerts.push(...await checkNews(state.lastCheck));
  alerts.push(...await checkStockPrice());

  if (alerts.length > 0) {
    const body = `Bloom Energy (BE) — Potential Stock Impact Alerts\n\n${alerts.join('\n\n')}\n\nGenerated: ${new Date().toLocaleString()}`;
    await sendEmail('BE Stock Impact Alert', body);
    console.log(`${alerts.length} alert(s) sent!`);
  } else {
    console.log('No significant events detected.');
  }

  await saveState();
}

// Run once now
runMonitor();

// Optional: Auto-run every hour
// setInterval(runMonitor, 60 * 60 * 1000);