#!/usr/bin/env node

const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");

// ─── CONFIG ────────────────────────────────────────────────────────────────────
const PAGESPEED_API_KEY = process.env.PAGESPEED_KEY;
const CLAUDE_API_KEY = process.env.ANTHROPIC_API_KEY;
const NETLIFY_TOKEN = process.env.NETLIFY_TOKEN;
const PORT = process.env.PORT || 3000;
const TEMPLATE_PATH = path.join(__dirname, "audit-template.html");

// ─── HELPERS ───────────────────────────────────────────────────────────────────

function httpsRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith("https") ? https : http;
    const req = proto.request(url, options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve(data);
          }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 500)}`));
        }
      });
    });
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

function httpsPost(url, body, headers = {}) {
  return httpsRequest(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function scoreClass(score) {
  if (score >= 80) return "score-good";
  if (score >= 50) return "score-ok";
  return "score-bad";
}

function log(msg) {
  console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

// ─── PAGESPEED INSIGHTS ────────────────────────────────────────────────────────

async function runPageSpeed(websiteUrl) {
  const encoded = encodeURIComponent(`https://${websiteUrl}`);
  const categories = ["performance", "seo", "accessibility", "best-practices"];
  const catParams = categories.map((c) => `category=${c.toUpperCase()}`).join("&");
  const apiUrl = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encoded}&${catParams}&strategy=MOBILE&key=${PAGESPEED_API_KEY}`;

  log(`Running PageSpeed for ${websiteUrl}...`);
  const data = await httpsRequest(apiUrl);

  const cats = data.lighthouseResult?.categories || {};
  const audits = data.lighthouseResult?.audits || {};

  const scores = {
    performance: Math.round((cats.performance?.score || 0) * 100),
    seo: Math.round((cats.seo?.score || 0) * 100),
    accessibility: Math.round((cats.accessibility?.score || 0) * 100),
    bestPractices: Math.round((cats["best-practices"]?.score || 0) * 100),
  };

  // Extract failed audits as issues
  const issues = [];
  for (const [key, audit] of Object.entries(audits)) {
    if (audit.score !== null && audit.score < 0.9 && audit.title) {
      issues.push({
        title: audit.title,
        description: audit.description?.replace(/<[^>]*>/g, "").slice(0, 200) || "",
        score: audit.score,
        id: key,
      });
    }
  }

  // Sort by score ascending (worst first), take top 8
  issues.sort((a, b) => a.score - b.score);

  log(`Scores: Perf=${scores.performance} SEO=${scores.seo} A11y=${scores.accessibility} BP=${scores.bestPractices}`);
  return { scores, issues: issues.slice(0, 8) };
}

// ─── CLAUDE AI ANALYSIS ────────────────────────────────────────────────────────

async function getClaudeAnalysis(businessName, websiteUrl, industry, scores, issues) {
  log("Getting Claude AI analysis...");

  const issueList = issues.map((i) => `- ${i.title} (score: ${i.score})`).join("\n");

  const prompt = `You are a web audit expert for a digital agency called Pixora Digital. Analyze these website audit results and provide actionable insights.

Business: ${businessName}
Website: ${websiteUrl}
Industry: ${industry}

PageSpeed Scores:
- Performance: ${scores.performance}/100
- SEO: ${scores.seo}/100
- Accessibility: ${scores.accessibility}/100
- Best Practices: ${scores.bestPractices}/100

Top Issues Found:
${issueList}

Respond in EXACTLY this JSON format (no markdown, no code blocks, just raw JSON):
{
  "performance_verdict": "One sentence about their performance score",
  "seo_verdict": "One sentence about their SEO score",
  "mobile_verdict": "One sentence about their mobile experience",
  "accessibility_verdict": "One sentence about their accessibility",
  "issues": [
    {
      "severity": "critical|warning|info",
      "title": "Issue title",
      "description": "What this means for their business in plain English",
      "category": "Performance|SEO|Mobile|Accessibility"
    }
  ],
  "revenue_loss": "$X,XXX",
  "before_items": [
    "Current problem 1",
    "Current problem 2",
    "Current problem 3",
    "Current problem 4",
    "Current problem 5"
  ],
  "after_items": [
    "What Pixora will deliver 1",
    "What Pixora will deliver 2",
    "What Pixora will deliver 3",
    "What Pixora will deliver 4",
    "What Pixora will deliver 5"
  ]
}

Keep all text concise and business-focused. The revenue loss should be a realistic monthly estimate based on industry (${industry}) and the severity of issues found. Make the before/after items specific to this ${industry} business. Provide exactly 5-8 issues, 5 before items, and 5 after items.`;

  const response = await httpsPost(
    "https://api.anthropic.com/v1/messages",
    {
      model: "claude-sonnet-4-6",
      max_tokens: 2000,
      messages: [{ role: "user", content: prompt }],
    },
    {
      "x-api-key": CLAUDE_API_KEY,
      "anthropic-version": "2023-06-01",
    }
  );

  const text = response.content?.[0]?.text || "{}";
  // Try to extract JSON from the response
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("Claude did not return valid JSON");

  const analysis = JSON.parse(jsonMatch[0]);
  log("Claude analysis complete.");
  return analysis;
}

// ─── BUILD HTML ────────────────────────────────────────────────────────────────

function buildHTML(businessName, websiteUrl, scores, analysis) {
  let template = fs.readFileSync(TEMPLATE_PATH, "utf-8");

  const overall = Math.round(
    (scores.performance + scores.seo + scores.accessibility + scores.bestPractices) / 4
  );

  // Score ring offset: 534 = full circumference, 0 = full circle
  const scoreOffset = Math.round(534 - (534 * overall) / 100);

  const today = new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  // Build issues HTML
  const issuesHTML = (analysis.issues || [])
    .map(
      (issue) => `
    <div class="issue-card">
      <div class="issue-severity severity-${issue.severity}"></div>
      <div class="issue-content">
        <h3>${issue.title}</h3>
        <p>${issue.description}</p>
        <span class="issue-tag">${issue.category}</span>
      </div>
    </div>`
    )
    .join("\n");

  // Build before/after items
  const beforeHTML = (analysis.before_items || [])
    .map(
      (item) => `<div class="comparison-item"><span class="icon">&#10060;</span> ${item}</div>`
    )
    .join("\n");

  const afterHTML = (analysis.after_items || [])
    .map(
      (item) => `<div class="comparison-item"><span class="icon">&#10004;</span> ${item}</div>`
    )
    .join("\n");

  // Mobile score = average of performance and best practices on mobile
  const mobileScore = Math.round((scores.performance + scores.bestPractices) / 2);

  // Replace all placeholders
  const replacements = {
    "{{BUSINESS_NAME}}": businessName,
    "{{WEBSITE_URL}}": websiteUrl,
    "{{AUDIT_DATE}}": today,
    "{{OVERALL_SCORE}}": overall,
    "{{SCORE_OFFSET}}": scoreOffset,
    "{{PERFORMANCE_SCORE}}": scores.performance,
    "{{PERFORMANCE_CLASS}}": scoreClass(scores.performance),
    "{{PERFORMANCE_VERDICT}}": analysis.performance_verdict || "",
    "{{SEO_SCORE}}": scores.seo,
    "{{SEO_CLASS}}": scoreClass(scores.seo),
    "{{SEO_VERDICT}}": analysis.seo_verdict || "",
    "{{MOBILE_SCORE}}": mobileScore,
    "{{MOBILE_CLASS}}": scoreClass(mobileScore),
    "{{MOBILE_VERDICT}}": analysis.mobile_verdict || "",
    "{{ACCESSIBILITY_SCORE}}": scores.accessibility,
    "{{ACCESSIBILITY_CLASS}}": scoreClass(scores.accessibility),
    "{{ACCESSIBILITY_VERDICT}}": analysis.accessibility_verdict || "",
    "{{ISSUES_HTML}}": issuesHTML,
    "{{REVENUE_LOSS}}": analysis.revenue_loss || "$0",
    "{{BEFORE_ITEMS}}": beforeHTML,
    "{{AFTER_ITEMS}}": afterHTML,
  };

  for (const [key, value] of Object.entries(replacements)) {
    template = template.split(key).join(String(value));
  }

  return template;
}

// ─── DEPLOY TO NETLIFY ─────────────────────────────────────────────────────────

async function deployToNetlify(html, businessName) {
  log("Deploying to Netlify...");

  const slug = businessName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

  // Create site
  let site;
  try {
    site = await httpsPost(
      "https://api.netlify.com/api/v1/sites",
      { name: `audit-${slug}-${Date.now()}` },
      { Authorization: `Bearer ${NETLIFY_TOKEN}` }
    );
  } catch (err) {
    // If name taken, try without timestamp
    site = await httpsPost(
      "https://api.netlify.com/api/v1/sites",
      {},
      { Authorization: `Bearer ${NETLIFY_TOKEN}` }
    );
  }

  const siteId = site.id;
  const siteUrl = site.ssl_url || site.url;
  log(`Site created: ${siteUrl}`);

  // Deploy via file digest
  const crypto = require("crypto");
  const fileHash = crypto.createHash("sha1").update(html).digest("hex");

  const deploy = await httpsPost(
    `https://api.netlify.com/api/v1/sites/${siteId}/deploys`,
    {
      files: { "/index.html": fileHash },
    },
    { Authorization: `Bearer ${NETLIFY_TOKEN}` }
  );

  const deployId = deploy.id;

  // Upload the file
  const uploadUrl = `https://api.netlify.com/api/v1/deploys/${deployId}/files/index.html`;
  await new Promise((resolve, reject) => {
    const req = https.request(
      uploadUrl,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${NETLIFY_TOKEN}`,
          "Content-Type": "application/octet-stream",
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
          else reject(new Error(`Upload failed: ${res.statusCode} ${data.slice(0, 300)}`));
        });
      }
    );
    req.on("error", reject);
    req.write(html);
    req.end();
  });

  log(`Deployed successfully!`);
  return siteUrl;
}

// ─── MAIN AUDIT FUNCTION ───────────────────────────────────────────────────────

async function runAudit(businessName, websiteUrl, industry) {
  console.log("\n" + "=".repeat(60));
  log(`Starting audit for: ${businessName}`);
  log(`Website: ${websiteUrl}`);
  log(`Industry: ${industry}`);
  console.log("=".repeat(60) + "\n");

  try {
    // Step 1: Run PageSpeed
    const { scores, issues } = await runPageSpeed(websiteUrl);

    // Step 2: Get Claude analysis
    const analysis = await getClaudeAnalysis(businessName, websiteUrl, industry, scores, issues);

    // Step 3: Build HTML
    const html = buildHTML(businessName, websiteUrl, scores, analysis);

    // Step 4: Deploy to Netlify
    const url = await deployToNetlify(html, businessName);

    console.log("\n" + "=".repeat(60));
    console.log(`\n  AUDIT COMPLETE!`);
    console.log(`  Business: ${businessName}`);
    console.log(`  Scores: Perf=${scores.performance} SEO=${scores.seo} A11y=${scores.accessibility}`);
    console.log(`  Revenue Loss: ${analysis.revenue_loss}`);
    console.log(`\n  LIVE URL: ${url}`);
    console.log("\n" + "=".repeat(60) + "\n");

    return url;
  } catch (err) {
    console.error(`\n[ERROR] Audit failed: ${err.message}`);
    if (err.message.includes("401") || err.message.includes("403")) {
      console.error("  -> Check your API keys (PageSpeed / Claude / Netlify)");
    }
    process.exit(1);
  }
}

// ─── HTTP SERVER MODE ──────────────────────────────────────────────────────────

function startServer() {
  const server = http.createServer(async (req, res) => {
    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }

    if (req.method === "POST" && req.url === "/audit") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        try {
          const { businessName, websiteUrl, industry } = JSON.parse(body);
          if (!businessName || !websiteUrl) {
            res.writeHead(400, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ error: "businessName and websiteUrl are required" }));
          }

          const url = await runAudit(businessName, websiteUrl, industry || "business");

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true, url }));
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
    } else {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "POST /audit only" }));
    }
  });

  server.listen(PORT, () => {
    console.log(`\n  Pixora Audit Server running on http://localhost:${PORT}`);
    console.log(`  POST /audit { businessName, websiteUrl, industry }\n`);
  });
}

// ─── CLI ENTRY ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args[0] === "test" && args.length >= 3) {
  const [, businessName, websiteUrl, industry = "business"] = args;
  runAudit(businessName, websiteUrl, industry);
} else if (args[0] === "serve" || args.length === 0) {
  startServer();
} else {
  console.log(`
  Pixora Audit Server

  Usage:
    node audit-server.js                           Start HTTP server on port ${PORT}
    node audit-server.js serve                     Start HTTP server on port ${PORT}
    node audit-server.js test "Name" "url" "type"  Run a single test audit

  Examples:
    node audit-server.js test "Smith Dental" "sensationalsmiles4u.com" "dental clinic"
    node audit-server.js serve
  `);
}
