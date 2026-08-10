import { registerCommand } from "../sender/telegram";
import { escapeHtml } from "../utils/escape";
import { supabase } from "../utils/supabase";

export function registerResearchCommands(): void {
  registerCommand("sec", async (ctx) => {
    if (!supabase.isConfigured()) {
      return "Supabase not configured. Run the daily digest to start SEC filing analysis.";
    }

    const parts = ctx.text.split(/\s+/).slice(1);
    const ticker = parts[0]?.toUpperCase();

    try {
      const params = ticker
        ? `ticker=eq.${encodeURIComponent(ticker)}&order=filing_date.desc&limit=5&select=*`
        : "order=filing_date.desc&limit=8&select=*";
      const filings = await supabase.queryRows<Record<string, unknown>>("sec_filings", params);
      if (!filings.length) {
        return ticker
          ? `No SEC filings found for <b>${ticker}</b>. Run the daily digest to populate filing data.`
          : "No SEC filings yet. Run the daily digest to start filing analysis.";
      }

      const lines: string[] = [];

      if (ticker) {
        lines.push(`📜 <b>SEC Filings — ${ticker}</b>`);
      } else {
        lines.push(`📜 <b>Latest SEC Filings</b>`);
      }
      lines.push("");

      for (const f of filings) {
        const formType = f.form_type as string;
        const company = f.company_name as string;
        const filingDate = f.filing_date as string;
        const impactScore = (f.impact_score as number) || 0;

        const impactEmoji = impactScore >= 8 ? "🔴" : impactScore >= 6 ? "🟡" : "⚪";
        const formEmoji = formType === "8-K" ? "⚡" : formType === "10-Q" ? "📊" : formType === "10-K" ? "📋" : "📄";

        lines.push(`${formEmoji} <b>${escapeHtml(company)}</b> — ${formType}`);
        lines.push(`   Date: ${filingDate} ${impactEmoji} Impact: ${impactScore}/10`);

        const data: string[] = [];
        if (f.capex !== null && f.capex !== undefined) data.push(`💰 Capex: $${(f.capex as number).toLocaleString()}M`);
        if (f.capex_guidance !== null && f.capex_guidance !== undefined) data.push(`📊 Capex Guide: $${(f.capex_guidance as number).toLocaleString()}M`);
        if (f.ai_revenue !== null && f.ai_revenue !== undefined) {
          const growth = f.ai_revenue_growth_pct ? ` (${(f.ai_revenue_growth_pct as number) >= 0 ? "+" : ""}${f.ai_revenue_growth_pct}%)` : "";
          data.push(`🤖 AI Rev: $${(f.ai_revenue as number).toLocaleString()}M${growth}`);
        }
        if (f.gross_margin !== null && f.gross_margin !== undefined) data.push(`📈 GM: ${f.gross_margin}%`);
        if (f.operating_margin !== null && f.operating_margin !== undefined) data.push(`📉 OM: ${f.operating_margin}%`);
        if (f.revenue_guidance !== null && f.revenue_guidance !== undefined) data.push(`🎯 Rev Guide: $${(f.revenue_guidance as number).toLocaleString()}M`);

        if (data.length > 0) {
          lines.push(`   ${data.join(" · ")}`);
        }

        // Show key takeaways
        const takeaways = f.key_takeaways as string[] | null;
        if (takeaways && takeaways.length > 0) {
          lines.push(`   <i>${escapeHtml(takeaways.slice(0, 2).join(" · "))}</i>`);
        }

        lines.push("");
      }

      lines.push("<i>Use /sec TICKER to filter by company (e.g., /sec NVDA)</i>");
      return { text: lines.join("\n") };
    } catch {
      return "Could not fetch SEC filings.";
    }
  });

  registerCommand("coverage", async (ctx) => {
    if (!supabase.isConfigured()) {
      return "Supabase not configured. Coverage history requires a database.";
    }

    const parts = ctx.text.split(/\s+/).slice(1);
    const ticker = parts[0]?.toUpperCase();
    if (!ticker) {
      return (
        `📰 <b>Coverage</b>\n\n` +
        `See how a ticker's news coverage has trended.\n\n` +
        `<b>Usage:</b>\n` +
        `• <code>/coverage NVDA</code> — last 14 days (default)\n` +
        `• <code>/coverage NVDA 30</code> — last 30 days`
      );
    }

    const days = parseInt(parts[1], 10) || 14;
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();

    try {
      const articles = await supabase.queryRows<{
        title: string;
        impact: string;
        impact_score: number;
        reason: string;
        created_at: string;
      }>(
        "articles",
        `affected_stocks=cs.{${encodeURIComponent(ticker)}}&created_at=gte.${encodeURIComponent(cutoff)}&select=title,impact,impact_score,reason,created_at&order=created_at.desc&limit=15`
      );

      if (!articles.length) {
        return `No recent coverage found for <b>${escapeHtml(ticker)}</b> in the last ${days} days.`;
      }

      const lines = [`📰 <b>Coverage — ${escapeHtml(ticker)}</b> · Last ${days}d`, ""];
      for (const a of articles) {
        const date = a.created_at?.split("T")[0] || "";
        const emoji = a.impact === "Bullish" ? "🟢" : a.impact === "Bearish" ? "🔴" : "⚪";
        lines.push(`${emoji} <b>${a.impact_score}/10</b> · ${date} — ${escapeHtml(a.title)}`);
        if (a.reason) lines.push(`   <i>${escapeHtml(a.reason)}</i>`);
      }
      lines.push("", "<i>Sorted newest first · Not financial advice</i>");
      return { text: lines.join("\n") };
    } catch {
      return "Could not fetch coverage history.";
    }
  });

  registerCommand("thesis", async (ctx) => {
    if (!supabase.isConfigured()) {
      return "Supabase not configured. Thesis snapshots require a database.";
    }

    const parts = ctx.text.split(/\s+/).slice(1);
    const ticker = parts[0]?.toUpperCase();

    type ThesisFields = {
      ticker: string;
      bull_case: string;
      bear_case: string;
      confidence: number;
      key_drivers: string[] | null;
    };

    try {
      if (!ticker) {
        // Portfolio view across all tickers — unaffected by the v11 history table.
        const theses = await supabase.queryRows<ThesisFields & { updated_at: string }>(
          "ticker_theses",
          "select=*&order=confidence.desc&limit=5"
        );
        if (!theses.length) {
          return "No thesis snapshots yet. They generate weekly (Sundays) once the pipeline has ≥1 week of history.";
        }
        const lines: string[] = ["🧭 <b>Top Thesis Snapshots</b>", ""];
        for (const t of theses) {
          lines.push(`<b>${escapeHtml(t.ticker)}</b> — confidence ${t.confidence}/10`);
          lines.push(`🟢 <i>${escapeHtml(t.bull_case)}</i>`);
          lines.push(`🔴 <i>${escapeHtml(t.bear_case)}</i>`);
          if (t.key_drivers?.length) lines.push(`🔑 ${t.key_drivers.map((d) => escapeHtml(d)).join(" · ")}`);
          lines.push("");
        }
        lines.push("<i>Refreshed weekly from 30d of pipeline data · Not financial advice</i>");
        return { text: lines.join("\n") };
      }

      // Ticker given — show up to the last 6 weekly snapshots (v11 history).
      // Falls back to the single latest-only snapshot (ticker_theses, v10) when
      // history is empty (e.g. the first week after this shipped) so this never
      // regresses to "no data" while a valid snapshot still exists.
      const history = await supabase.queryRows<ThesisFields & { week_of: string }>(
        "ticker_thesis_history",
        `ticker=eq.${encodeURIComponent(ticker)}&select=*&order=week_of.desc&limit=6`
      );

      if (history.length > 0) {
        const lines: string[] = [`🧭 <b>Thesis — ${escapeHtml(ticker)}</b>`, ""];
        for (const t of history) {
          lines.push(`<b>${t.week_of}</b> · Confidence: ${t.confidence}/10`);
          lines.push(`🟢 <i>${escapeHtml(t.bull_case)}</i>`);
          lines.push(`🔴 <i>${escapeHtml(t.bear_case)}</i>`);
          if (t.key_drivers?.length) lines.push(`🔑 ${t.key_drivers.map((d) => escapeHtml(d)).join(" · ")}`);
          lines.push("");
        }
        lines.push("<i>Newest first · Not financial advice</i>");
        return { text: lines.join("\n") };
      }

      const theses = await supabase.queryRows<ThesisFields & { updated_at: string }>(
        "ticker_theses",
        `ticker=eq.${encodeURIComponent(ticker)}&select=*`
      );
      if (!theses.length) {
        return `No thesis snapshot for <b>${escapeHtml(ticker)}</b> yet. Snapshots refresh weekly for the top-10 most-mentioned tickers.`;
      }
      const t = theses[0];
      const updated = t.updated_at?.split("T")[0] || "";
      const lines: string[] = [
        `🧭 <b>Thesis — ${escapeHtml(ticker)}</b>`,
        "",
        `Confidence: <b>${t.confidence}/10</b> · updated ${updated}`,
        `🟢 <i>${escapeHtml(t.bull_case)}</i>`,
        `🔴 <i>${escapeHtml(t.bear_case)}</i>`,
      ];
      if (t.key_drivers?.length) lines.push(`🔑 ${t.key_drivers.map((d) => escapeHtml(d)).join(" · ")}`);
      lines.push("", "<i>Refreshed weekly from 30d of pipeline data · Not financial advice</i>");
      return { text: lines.join("\n") };
    } catch {
      return "Could not fetch thesis snapshots.";
    }
  });
}
