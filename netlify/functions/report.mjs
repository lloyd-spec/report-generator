// netlify/functions/report.mjs
// The engine room of the Monthly Report Generator. Reports are a recurring
// monthly cost, so this runs almost entirely on Sonnet - it is assembling and
// phrasing figures the team has already gathered, not reasoning from scratch.
//
//   writer  - Sonnet. Drafts each report section in the house style.
//   auditor - Haiku. Checks every number in the draft against the confirmed
//             figures and flags anything that crept in.
//
// It can also pull a client's coverage straight from the shared Coverage
// Dashboard database, so the PR numbers arrive pre-filled.
//
// HARD RULE: the model must never invent a statistic. Only figures from the
// confirmed inputs may appear.
//
// Env needed: ANTHROPIC_API_KEY, SITE_PASSWORD, SUPABASE_URL, SUPABASE_SERVICE_KEY

const TIERS = {
  writer:  { model: "claude-sonnet-4-6",         maxTokens: 1800 },
  auditor: { model: "claude-haiku-4-5-20251001", maxTokens: 1200 }
};

export default async (request) => {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body;
  try { body = await request.json(); } catch { return json({ error: "Bad request" }, 400); }

  const sitePassword = process.env.SITE_PASSWORD;
  const sent = request.headers.get("x-password") || body.password;
  if (!sitePassword || sent !== sitePassword) return json({ error: "Unauthorised" }, 401);

  if (body.ping) return json({ ok: true });

  const base = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
  const sb = (path, opts = {}) => fetch(base + "/rest/v1/" + path, {
    ...opts,
    headers: { "apikey": key, "Authorization": "Bearer " + key, "Content-Type": "application/json", ...(opts.headers || {}) }
  });

  // ---- Pull coverage from the Coverage Dashboard's table ----
  if (body.action === "coverage-list") {
    if (!base || !key) return json({ error: "Storage is not configured. Add SUPABASE_URL and SUPABASE_SERVICE_KEY in Netlify settings." }, 500);
    const r = await sb("coverage_clients?select=id,name,date_from,date_to,updated_at&order=name.asc");
    if (!r.ok) return json({ error: "Could not reach the coverage database (" + r.status + ")" }, 502);
    return json({ ok: true, clients: await r.json() });
  }
  if (body.action === "coverage-get") {
    if (!base || !key) return json({ error: "Storage is not configured." }, 500);
    if (!body.id) return json({ error: "Need a client id" }, 400);
    const r = await sb("coverage_clients?select=*&id=eq." + encodeURIComponent(body.id) + "&limit=1");
    if (!r.ok) return json({ error: "Could not load coverage (" + r.status + ")" }, 502);
    const rows = await r.json();
    if (!rows.length) return json({ error: "Client not found in the Coverage Dashboard" }, 404);
    return json({ ok: true, client: rows[0] });
  }

  // ---- Report storage (table monthly_reports) ----
  if (body.action === "save" || body.action === "list" || body.action === "get") {
    if (!base || !key) return json({ error: "Storage is not configured." }, 500);
    try {
      if (body.action === "save") {
        if (!body.client || !body.html) return json({ error: "Need a client and the report" }, 400);
        const r = await sb("monthly_reports", {
          method: "POST",
          headers: { "Prefer": "return=representation" },
          body: JSON.stringify({ client: String(body.client).trim(), html: body.html, meta: body.meta || {} })
        });
        if (!r.ok) return json({ error: "Could not save (" + r.status + ")" }, 502);
        const rows = await r.json();
        return json({ ok: true, id: rows[0] && rows[0].id });
      }
      if (body.action === "list") {
        const q = "monthly_reports?select=id,client,created_at,meta" +
          (body.client ? "&client=eq." + encodeURIComponent(String(body.client).trim()) : "") +
          "&order=created_at.desc&limit=15";
        const r = await sb(q);
        if (!r.ok) return json({ error: "Could not list (" + r.status + ")" }, 502);
        return json({ ok: true, docs: await r.json() });
      }
      const r = await sb("monthly_reports?select=*&id=eq." + encodeURIComponent(body.id) + "&limit=1");
      if (!r.ok) return json({ error: "Could not load (" + r.status + ")" }, 502);
      const rows = await r.json();
      if (!rows.length) return json({ error: "Not found" }, 404);
      return json({ ok: true, doc: rows[0] });
    } catch (e) {
      return json({ error: "Server error: " + (e.message || e) }, 500);
    }
  }

  // ---- AI writing (streamed) ----
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return json({ error: "ANTHROPIC_API_KEY is not set in Netlify" }, 500);

  const tier = TIERS[body.tier] || TIERS.writer;
  const upstream = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: tier.model,
      max_tokens: tier.maxTokens,
      stream: true,
      system: body.system || "",
      messages: [{ role: "user", content: body.prompt || "" }]
    })
  });
  if (!upstream.ok) {
    const errText = await upstream.text().catch(() => "");
    return json({ error: "AI request failed (" + upstream.status + "): " + errText.slice(0, 300) }, 502);
  }
  const stream = new ReadableStream({
    async start(controller) {
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop();
          for (const line of lines) {
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (data === "[DONE]") continue;
            try {
              const evt = JSON.parse(data);
              if (evt.type === "content_block_delta" && evt.delta && evt.delta.text) {
                controller.enqueue(new TextEncoder().encode(evt.delta.text));
              }
            } catch {}
          }
        }
      } catch {}
      controller.close();
    }
  });
  return new Response(stream, { headers: { "content-type": "text/plain; charset=utf-8" } });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}
