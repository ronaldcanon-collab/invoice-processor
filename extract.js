/**
 * /api/extract.js  –  Vercel Serverless Function
 *
 * Secure proxy to AI providers for invoice extraction.
 * Provider selection logic:
 *   1. If ANTHROPIC_API_KEY is set  → use Anthropic Claude (priority)
 *   2. Else if GEMINI_API_KEY is set → use Google Gemini 1.5 Flash (free tier)
 *   3. Both keys set → Anthropic primary, Gemini auto-fallback if Anthropic fails
 *   4. No keys → 500 error
 *
 * Expects POST body: { imageBase64: string, mediaType: string, prompt: string }
 * Returns unified: { provider: string, content: [{ type: "text", text: string }] }
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
      model:      "claude-sonnet-4-20250514",
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
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${data?.error?.message || JSON.stringify(data)}`);
  if (!data.content?.length) throw new Error("Anthropic returned empty content");

  return { provider: "anthropic", content: data.content };
}

// ─── Gemini ───────────────────────────────────────────────────────────────────
async function callGemini(apiKey, imageBase64, mediaType, prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;

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
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${data?.error?.message || JSON.stringify(data)}`);

  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  if (!text) {
    const reason = data?.candidates?.[0]?.finishReason || "unknown";
    throw new Error(`Gemini returned empty content (finishReason: ${reason})`);
  }

  // Normalise to Anthropic-style shape so frontend code is identical
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

  // ~5MB decoded size guard
  const approxKB = Math.round(imageBase64.length * 0.75 / 1024);
  if (approxKB > 5120) {
    return res.status(413).json({ error: `Image too large (${approxKB}KB). Max ~5MB.` });
  }

  const useAnthropic = !!anthropicKey;
  console.log(`[extract] provider=${useAnthropic ? "anthropic" : "gemini"} size=${approxKB}KB`);

  try {
    const result = useAnthropic
      ? await callAnthropic(anthropicKey, imageBase64, mediaType, prompt)
      : await callGemini(geminiKey, imageBase64, mediaType, prompt);

    return res.status(200).json(result);

  } catch (primaryErr) {
    console.error(`[extract] primary error:`, primaryErr.message);

    // If Anthropic failed and Gemini key exists → auto-fallback
    if (useAnthropic && geminiKey) {
      console.log("[extract] Anthropic failed — trying Gemini fallback");
      try {
        const fallback = await callGemini(geminiKey, imageBase64, mediaType, prompt);
        return res.status(200).json({ ...fallback, usedFallback: true });
      } catch (fallbackErr) {
        console.error("[extract] Gemini fallback failed:", fallbackErr.message);
        return res.status(502).json({
          error: `Both providers failed.\nAnthropic: ${primaryErr.message}\nGemini: ${fallbackErr.message}`,
        });
      }
    }

    return res.status(502).json({ error: primaryErr.message });
  }
}
