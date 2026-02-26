/**
 * /api/extract.js  –  Vercel Serverless Function
 *
 * Provider priority:
 *   1. ANTHROPIC_API_KEY set → try Anthropic first
 *   2. If Anthropic fails for ANY reason (quota, credits, error) → fall back to Gemini
 *   3. GEMINI_API_KEY only → use Gemini directly
 *
 * Expects POST body: { imageBase64: string, mediaType: string, prompt: string }
 * Returns: { provider: string, content: [{ type: "text", text: string }] }
 */

// ─── Anthropic ────────────────────────────────────────────────────────────────
async function callAnthropic(apiKey, imageBase64, mediaType, prompt) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method:  "POST",
    headers: {
      "Content-Type":      "application/json",
      "x-api-key":         apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model:      "claude-haiku-4-5-20251001",
      max_tokens: 4000,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: imageBase64 } },
          { type: "text",  text: prompt },
        ],
      }],
    }),
  });

  const data = await res.json();

  // Non-2xx HTTP error
  if (!res.ok) {
    const msg = data?.error?.message || JSON.stringify(data);
    throw new Error(`Anthropic HTTP ${res.status}: ${msg}`);
  }

  // Anthropic sometimes returns 200 with an error body (quota exhausted, credits, overload)
  if (data.error) {
    throw new Error(`Anthropic API error: ${data.error.message || JSON.stringify(data.error)}`);
  }

  // Check stop reason — overloaded or token issues come through here
  if (data.stop_reason === "error" || !data.content?.length) {
    throw new Error(`Anthropic returned no content (stop_reason: ${data.stop_reason})`);
  }

  return { provider: "anthropic", content: data.content };
}

// ─── Gemini ───────────────────────────────────────────────────────────────────
async function callGemini(apiKey, imageBase64, mediaType, prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${apiKey}`;

  const res = await fetch(url, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{
        parts: [
          { inline_data: { mime_type: mediaType, data: imageBase64 } },
          { text: prompt },
        ],
      }],
      generationConfig: {
        temperature:     0.1,
        maxOutputTokens: 4000,
      },
    }),
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(`Gemini HTTP ${res.status}: ${data?.error?.message || JSON.stringify(data)}`);
  }

  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  if (!text) {
    const reason = data?.candidates?.[0]?.finishReason || "unknown";
    throw new Error(`Gemini returned empty content (finishReason: ${reason})`);
  }

  // Normalise to same shape as Anthropic so frontend code is identical
  return { provider: "gemini", content: [{ type: "text", text }] };
}

// ─── Handler ──────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const geminiKey    = process.env.GEMINI_API_KEY;

  if (!anthropicKey && !geminiKey) {
    return res.status(500).json({
      error: "No API key configured. Add ANTHROPIC_API_KEY or GEMINI_API_KEY in Vercel → Settings → Environment Variables.",
    });
  }

  const { imageBase64, mediaType, prompt } = req.body || {};
  if (!imageBase64 || !mediaType || !prompt) {
    return res.status(400).json({ error: "Missing fields: imageBase64, mediaType, prompt" });
  }

  const approxKB = Math.round(imageBase64.length * 0.75 / 1024);
  if (approxKB > 5120) {
    return res.status(413).json({ error: `Image too large (${approxKB}KB). Max ~5MB.` });
  }

  // ── Try Anthropic first if key is available ──
  if (anthropicKey) {
    try {
      console.log(`[extract] trying Anthropic, size=${approxKB}KB`);
      const result = await callAnthropic(anthropicKey, imageBase64, mediaType, prompt);
      console.log("[extract] Anthropic succeeded");
      return res.status(200).json(result);
    } catch (anthropicErr) {
      console.warn(`[extract] Anthropic failed: ${anthropicErr.message}`);

      // If no Gemini key to fall back to, return the Anthropic error
      if (!geminiKey) {
        return res.status(502).json({ error: `Anthropic failed: ${anthropicErr.message}` });
      }

      console.log("[extract] Falling back to Gemini...");
    }
  }

  // ── Gemini (primary if no Anthropic key, or fallback) ──
  try {
    console.log(`[extract] trying Gemini, size=${approxKB}KB`);
    const result = await callGemini(geminiKey, imageBase64, mediaType, prompt);
    console.log("[extract] Gemini succeeded");
    return res.status(200).json(result);
  } catch (geminiErr) {
    console.error(`[extract] Gemini failed: ${geminiErr.message}`);
    return res.status(502).json({ error: `Gemini failed: ${geminiErr.message}` });
  }
}
