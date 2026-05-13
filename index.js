#!/usr/bin/env node
// Studie+ MCP Server — HTTP transport, Railway-ready
// No build step. Just: npm install && node index.js

const path = require("path");
try { require("dotenv").config({ path: path.join(__dirname, ".env") }); } catch {}

const http = require("http");
const { randomUUID } = require("crypto");
const { createRequire } = require("module");
const _sdkPkg = require.resolve("@modelcontextprotocol/sdk/package.json").replace("/dist/cjs/package.json", "/package.json");
const sdkRequire = createRequire(_sdkPkg);
const { McpServer } = sdkRequire("./dist/cjs/server/mcp.js");
const { StreamableHTTPServerTransport } = sdkRequire("./dist/cjs/server/streamableHttp.js");
const { z } = require("zod");
const { chromium } = require("playwright");

const PORT = process.env.PORT || 3000;

// ── Browser state ──────────────────────────────
let browser = null, context = null, page = null;
let sessionState = { isLoggedIn: false, schoolSlug: null };

async function getBrowserPage() {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage"] });
    context = await browser.newContext({ locale: "da-DK" });
    page = await context.newPage();
    sessionState = { isLoggedIn: false, schoolSlug: null };
  }
  if (!page || page.isClosed()) { page = await context.newPage(); sessionState.isLoggedIn = false; }
  return page;
}

async function closeBrowser() {
  if (page && !page.isClosed()) await page.close().catch(() => {});
  if (context) await context.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
  browser = null; context = null; page = null;
  sessionState = { isLoggedIn: false, schoolSlug: null };
}

async function ensureLoggedIn() {
  if (!sessionState.isLoggedIn) return { ok: false, message: "Ikke logget ind. Brug studieplus_login først." };
  return { ok: true };
}

// ── Login ──────────────────────────────────────
async function doLogin(schoolName, username, password) {
  const p = await getBrowserPage();
  try {
    await p.goto("https://all.uddataplus.dk", { waitUntil: "networkidle", timeout: 30000 });
    const options = await p.$$eval("select option", opts => opts.map(o => ({ value: o.value, text: o.textContent.trim() })));
    const match = options.find(o => o.text.toLowerCase().includes(schoolName.toLowerCase()));
    if (!match) {
      const names = options.filter(o => o.text).map(o => o.text).slice(0, 15).join(", ");
      return { success: false, message: `Skolen "${schoolName}" blev ikke fundet. Prøv: ${names}` };
    }
    await p.selectOption("select", match.value);
    sessionState.schoolSlug = match.value;
    await p.click('button[type="submit"], input[type="submit"]');
    await p.waitForLoadState("networkidle", { timeout: 20000 });
    const url1 = p.url();
    process.stderr.write("After school select: " + url1 + "\n");
    if (url1.includes("uni-login") || url1.includes("unilogin") || url1.includes("broker")) {
      await p.fill('input[type="text"], input[name="username"]', username);
      await p.fill('input[type="password"]', password);
      await p.click('button[type="submit"], input[type="submit"]');
      await p.waitForLoadState("networkidle", { timeout: 20000 });
    } else if (url1.includes("login") || url1.includes("skolid")) {
      const uf = await p.$('input[type="text"], input[name="username"]');
      const pf = await p.$('input[type="password"]');
      if (uf) await uf.fill(username);
      if (pf) await pf.fill(password);
      await p.click('button[type="submit"], input[type="submit"]');
      await p.waitForLoadState("networkidle", { timeout: 20000 });
    }
    const finalUrl = p.url();
    process.stderr.write("After login: " + finalUrl + "\n");
    if (finalUrl.includes("uddataplus.dk") && !finalUrl.includes("login")) {
      sessionState.isLoggedIn = true;
      return { success: true, message: "Logget ind på Studie+ (" + match.text + ")" };
    }
    return { success: false, message: "Login mislykkedes. Stadig på: " + finalUrl };
  } catch (err) { return { success: false, message: "Login fejl: " + err.message }; }
}

// ── Schedule ───────────────────────────────────
function getCurrentWeek() {
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 1);
  return Math.ceil(((now - start) / 86400000 + start.getDay() + 1) / 7);
}

async function fetchSchedule(week, year) {
  const auth = await ensureLoggedIn();
  if (!auth.ok) return { success: false, message: auth.message };
  const p = await getBrowserPage();
  const tw = week || getCurrentWeek();
  const ty = year || new Date().getFullYear();
  try {
    await p.goto("https://all.uddataplus.dk/skema", { waitUntil: "networkidle", timeout: 20000 });
    const events = await p.evaluate(function(tw) {
      var results = [];
      var selectors = [".event",".lesson",".activity","[class*='event']","[class*='lesson']","td.filled"];
      for (var si = 0; si < selectors.length; si++) {
        var els = document.querySelectorAll(selectors[si]);
        if (els.length === 0) continue;
        els.forEach(function(el) {
          var text = el.textContent || "";
          var timeMatch = text.match(/(\d{1,2}[:.]\d{2})\s*[-\u2013]\s*(\d{1,2}[:.]\d{2})/);
          var cancelled = el.className.includes("cancel") || el.className.includes("aflyst");
          var td = el.closest("td");
          var colIdx = td ? Array.from(td.parentElement.children).indexOf(td) : 0;
          var days = ["Mandag","Tirsdag","Onsdag","Torsdag","Fredag","Lordag","Sondag"];
          var titleEl = el.querySelector(".title,.subject,strong,h3,h4");
          results.push({
            title: (titleEl ? titleEl.textContent : text).trim().slice(0, 80),
            teacher: (el.querySelector("[class*='teacher'],[class*='laerer']") || {textContent:""}).textContent.trim(),
            room: (el.querySelector("[class*='room'],[class*='lokale']") || {textContent:""}).textContent.trim(),
            startTime: timeMatch ? timeMatch[1].replace(".",":") : "",
            endTime: timeMatch ? timeMatch[2].replace(".",":") : "",
            dayOfWeek: days[colIdx] || "",
            note: (el.querySelector("[class*='note']") || {textContent:""}).textContent.trim(),
            cancelled: cancelled, week: tw
          });
        });
        break;
      }
      return results;
    }, tw);
    return { success: true, data: { week: tw, year: ty, events: events } };
  } catch (err) { return { success: false, message: "Fejl ved hentning af skema: " + err.message }; }
}

async function fetchScheduleRaw() {
  const auth = await ensureLoggedIn();
  if (!auth.ok) return { success: false, message: auth.message };
  const p = await getBrowserPage();
  try {
    await p.goto("https://all.uddataplus.dk/skema", { waitUntil: "networkidle", timeout: 20000 });
    const url = p.url();
    const html = await p.evaluate(function() {
      var el = document.querySelector("main,#main,.content,body");
      return (el ? el.innerHTML : "").slice(0, 6000);
    });
    return { success: true, url: url, html: html };
  } catch (err) { return { success: false, message: err.message }; }
}

async function fetchStudentInfo() {
  const auth = await ensureLoggedIn();
  if (!auth.ok) return { success: false, message: auth.message };
  const p = await getBrowserPage();
  try {
    var paths = ["/profil","/profil/vis","/"];
    for (var i = 0; i < paths.length; i++) {
      await p.goto("https://all.uddataplus.dk" + paths[i], { waitUntil: "networkidle", timeout: 15000 });
      if (p.url().includes("login")) continue;
      const info = await p.evaluate(function() {
        function get(sels) { for (var i=0;i<sels.length;i++){var t=document.querySelector(sels[i]);if(t&&t.textContent.trim())return t.textContent.trim();}return ""; }
        return {
          name: get([".student-name",".name","h1",".profile-name"]),
          studentNumber: get([".student-number",".elevnr","[class*='student-number']"]),
          class: get([".class",".klasse","[class*='class']"]),
          school: get([".school",".skole","header .institution"]),
          email: get([".email","a[href^='mailto:']"])
        };
      });
      if (info.name) return { success: true, data: info };
    }
    return { success: false, message: "Kunne ikke finde elevprofil." };
  } catch (err) { return { success: false, message: err.message }; }
}

async function fetchMessages(unreadOnly) {
  const auth = await ensureLoggedIn();
  if (!auth.ok) return { success: false, message: auth.message };
  const p = await getBrowserPage();
  try {
    var pts = ["/beskeder","/messages","/indbakke"];
    for (var i = 0; i < pts.length; i++) {
      await p.goto("https://all.uddataplus.dk" + pts[i], { waitUntil: "networkidle", timeout: 15000 });
      if (!p.url().includes("login")) break;
    }
    const msgs = await p.evaluate(function(unreadOnly) {
      var results = [];
      document.querySelectorAll(".message,.besked,.conversation,.inbox-item,[class*='message'],[class*='besked']").forEach(function(el, i) {
        var isUnread = el.classList.contains("unread") || el.classList.contains("ulaest");
        if (unreadOnly && !isUnread) return;
        var fromEl = el.querySelector("[class*='from'],[class*='sender']");
        var subEl = el.querySelector("[class*='subject'],[class*='emne'],h3,h4");
        var prevEl = el.querySelector(".preview,p");
        var dateEl = el.querySelector("[class*='date'],time");
        results.push({
          id: el.getAttribute("data-id") || String(i),
          from: fromEl ? fromEl.textContent.trim() : "",
          subject: subEl ? subEl.textContent.trim() : "",
          preview: prevEl ? prevEl.textContent.trim().slice(0,150) : "",
          date: dateEl ? dateEl.textContent.trim() : "",
          unread: isUnread
        });
      });
      return results;
    }, unreadOnly);
    return { success: true, data: msgs };
  } catch (err) { return { success: false, message: err.message }; }
}

async function fetchAbsence() {
  const auth = await ensureLoggedIn();
  if (!auth.ok) return { success: false, message: auth.message };
  const p = await getBrowserPage();
  try {
    var pts = ["/fravaer","/fravr","/absence"];
    for (var i = 0; i < pts.length; i++) {
      await p.goto("https://all.uddataplus.dk" + pts[i], { waitUntil: "networkidle", timeout: 15000 });
      if (!p.url().includes("login")) break;
    }
    const result = await p.evaluate(function() {
      var records = [];
      document.querySelectorAll("table tbody tr").forEach(function(row) {
        var cells = row.querySelectorAll("td");
        if (cells.length >= 2) records.push({ date: cells[0].textContent.trim(), subject: cells[1].textContent.trim(), lessonTitle: cells[2] ? cells[2].textContent.trim() : "", status: cells[3] ? cells[3].textContent.trim() : "" });
      });
      var pctEl = document.querySelector("[class*='percent'],[class*='procent']");
      var pctText = pctEl ? pctEl.textContent : "";
      var pctMatch = pctText.match(/([\d.,]+)\s*%/);
      return { records: records, totalPercent: pctMatch ? parseFloat(pctMatch[1].replace(",",".")) : null };
    });
    return { success: true, data: result.records, totalPercent: result.totalPercent };
  } catch (err) { return { success: false, message: err.message }; }
}

async function listSchools() {
  const p = await getBrowserPage();
  try {
    await p.goto("https://all.uddataplus.dk", { waitUntil: "networkidle", timeout: 20000 });
    const schools = await p.$$eval("select option", function(opts) { return opts.map(function(o){return o.textContent.trim();}).filter(function(t){return t.length>0;}); });
    return { success: true, schools: schools };
  } catch (err) { return { success: false, message: err.message }; }
}

// ── Build MCP server ───────────────────────────
function buildMcpServer() {
  const server = new McpServer({ name: "studieplus-mcp-server", version: "1.0.0" });

  server.registerTool("studieplus_login", {
    title: "Log ind på Studie+",
    description: "Log ind med skolenavn og UNI-login. Felter kan udelades hvis STUDIEPLUS_* env vars er sat.",
    inputSchema: z.object({ school_name: z.string().optional(), username: z.string().optional(), password: z.string().optional() }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, async function(args) {
    const s = args.school_name || process.env.STUDIEPLUS_SCHOOL || "";
    const u = args.username    || process.env.STUDIEPLUS_USERNAME || "";
    const pw = args.password   || process.env.STUDIEPLUS_PASSWORD || "";
    if (!s || !u || !pw) return { content: [{ type: "text", text: "Manglende oplysninger. Angiv school_name, username, password eller sæt STUDIEPLUS_* env vars." }] };
    const r = await doLogin(s, u, pw);
    return { content: [{ type: "text", text: r.message }] };
  });

  server.registerTool("studieplus_list_schools", {
    title: "Vis skoler",
    description: "Vis alle skoler i Studie+ dropdown-listen.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, async function() {
    const r = await listSchools();
    if (!r.success) return { content: [{ type: "text", text: r.message }] };
    return { content: [{ type: "text", text: r.schools.length + " skoler:\n\n" + r.schools.join("\n") }] };
  });

  server.registerTool("studieplus_get_schedule", {
    title: "Hent ugeskema",
    description: "Hent dit skema for en given uge. Standard er indeværende uge.",
    inputSchema: z.object({ week: z.number().int().min(1).max(53).optional(), year: z.number().int().min(2020).max(2030).optional() }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, async function(args) {
    const r = await fetchSchedule(args.week, args.year);
    if (!r.success) return { content: [{ type: "text", text: r.message }] };
    const data = r.data;
    var text = "## Skema \u2014 Uge " + data.week + ", " + data.year + "\n\n";
    if (data.events.length === 0) {
      text += "Ingen lektioner fundet.\n\nPr\u00f8v studieplus_get_schedule_raw for r\u00e5 HTML.";
    } else {
      var byDay = {};
      data.events.forEach(function(e) { if (!byDay[e.dayOfWeek||"?"]) byDay[e.dayOfWeek||"?"] = []; byDay[e.dayOfWeek||"?"].push(e); });
      Object.keys(byDay).forEach(function(day) {
        text += "### " + day + "\n";
        byDay[day].forEach(function(e) {
          var time = e.startTime ? e.startTime + "\u2013" + e.endTime : "?";
          text += "- **" + time + "** " + e.title + (e.cancelled ? " ~~AFLYST~~" : "");
          if (e.teacher) text += " \u00b7 \ud83d\udc64 " + e.teacher;
          if (e.room) text += " \u00b7 \ud83c\udfeb " + e.room;
          if (e.note) text += "\n  \ud83d\udcdd " + e.note;
          text += "\n";
        });
        text += "\n";
      });
    }
    return { content: [{ type: "text", text: text }] };
  });

  server.registerTool("studieplus_get_schedule_raw", {
    title: "R\u00e5 skema HTML",
    description: "Hent r\u00e5 HTML fra skema-siden. Brug som fallback hvis get_schedule ikke virker.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, async function() {
    const r = await fetchScheduleRaw();
    if (!r.success) return { content: [{ type: "text", text: r.message }] };
    return { content: [{ type: "text", text: "URL: " + r.url + "\n\n" + r.html }] };
  });

  server.registerTool("studieplus_get_student_info", {
    title: "Elevprofil",
    description: "Hent dit navn, klasse, elevnummer og email.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async function() {
    const r = await fetchStudentInfo();
    if (!r.success) return { content: [{ type: "text", text: r.message }] };
    const d = r.data;
    var lines = ["\ud83d\udc64 **" + d.name + "**"];
    if (d.studentNumber) lines.push("Elevnr: " + d.studentNumber);
    if (d.class) lines.push("Klasse: " + d.class);
    if (d.school) lines.push("Skole: " + d.school);
    if (d.email) lines.push("Email: " + d.email);
    return { content: [{ type: "text", text: lines.join("\n") }] };
  });

  server.registerTool("studieplus_get_messages", {
    title: "Beskeder",
    description: "Hent beskeder fra din Studie+ indbakke.",
    inputSchema: z.object({ unread_only: z.boolean().default(false) }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async function(args) {
    const r = await fetchMessages(args.unread_only);
    if (!r.success) return { content: [{ type: "text", text: r.message }] };
    if (r.data.length === 0) return { content: [{ type: "text", text: args.unread_only ? "Ingen ul\u00e6ste beskeder." : "Ingen beskeder fundet." }] };
    var lines = r.data.map(function(m) { return (m.unread ? "\ud83d\udd35 " : "   ") + "**" + (m.subject||"(ingen emne)") + "**\n   Fra: " + m.from + " \u00b7 " + m.date + "\n   " + m.preview; });
    return { content: [{ type: "text", text: "## Beskeder (" + r.data.length + ")\n\n" + lines.join("\n\n") }] };
  });

  server.registerTool("studieplus_get_absence", {
    title: "Frav\u00e6r",
    description: "Hent dine frav\u00e6rsregistreringer.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async function() {
    const r = await fetchAbsence();
    if (!r.success) return { content: [{ type: "text", text: r.message }] };
    var text = "## Frav\u00e6r\n\n";
    if (r.totalPercent != null) text += "\ud83d\udcca **Samlet: " + r.totalPercent + "%**\n\n";
    if (r.data.length === 0) { text += "Ingen registreringer fundet."; }
    else { r.data.forEach(function(rec) { text += "- " + rec.date + " \u00b7 **" + rec.subject + "** " + (rec.lessonTitle ? "(" + rec.lessonTitle + ")" : "") + " \u00b7 " + rec.status + "\n"; }); }
    return { content: [{ type: "text", text: text }] };
  });

  server.registerTool("studieplus_session_status", {
    title: "Sessionsstatus",
    description: "Tjek om du er logget ind.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async function() {
    return { content: [{ type: "text", text: sessionState.isLoggedIn ? "\u2705 Logget ind p\u00e5 Studie+" : "\u274c Ikke logget ind. Brug studieplus_login." }] };
  });

  server.registerTool("studieplus_logout", {
    title: "Log ud",
    description: "Luk browsersessionen og log ud.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async function() {
    await closeBrowser();
    return { content: [{ type: "text", text: "Logget ud." }] };
  });

  return server;
}

// ── HTTP server ────────────────────────────────
const transports = new Map();

const httpServer = http.createServer(async function(req, res) {
  // Health check for Railway
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", loggedIn: sessionState.isLoggedIn }));
    return;
  }

  if (req.url === "/mcp") {
    if (req.method === "POST") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString();

      const sessionId = req.headers["mcp-session-id"];
      let transport = sessionId ? transports.get(sessionId) : null;

      if (!transport) {
        const server = buildMcpServer();
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: function() { return randomUUID(); },
          onsessioninitialized: function(id) { transports.set(id, transport); }
        });
        transport.onclose = function() { if (transport.sessionId) transports.delete(transport.sessionId); };
        await server.connect(transport);
      }

      await transport.handleRequest(req, res, body);
      return;
    }

    if (req.method === "GET" || req.method === "DELETE") {
      const sessionId = req.headers["mcp-session-id"];
      const transport = sessionId ? transports.get(sessionId) : null;
      if (!transport) { res.writeHead(404); res.end(JSON.stringify({ error: "Session not found" })); return; }
      await transport.handleRequest(req, res);
      return;
    }
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found", hint: "MCP endpoint is /mcp" }));
});

// ── Start ──────────────────────────────────────
async function main() {
  const s  = process.env.STUDIEPLUS_SCHOOL;
  const u  = process.env.STUDIEPLUS_USERNAME;
  const pw = process.env.STUDIEPLUS_PASSWORD;
  if (s && u && pw) {
    process.stderr.write("Auto-login: " + s + "...\n");
    const result = await doLogin(s, u, pw);
    process.stderr.write("Auto-login: " + result.message + "\n");
  }

  httpServer.listen(PORT, function() {
    process.stderr.write("Studie+ MCP server korer pa port " + PORT + "\n");
    process.stderr.write("MCP endpoint: http://localhost:" + PORT + "/mcp\n");
    process.stderr.write("Health check: http://localhost:" + PORT + "/health\n");
  });
}

main().catch(function(err) {
  process.stderr.write("Fatal: " + err.message + "\n");
  process.exit(1);
});
