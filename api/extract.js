/**
 * /api/extract.js  –  Vercel Serverless Function
 *
 * Acts as a secure proxy between the browser and Anthropic's API.
 * The ANTHROPIC_API_KEY env var is never exposed to the client.
 *
 * Expects POST body: { imageBase64: string, mediaType: string, prompt: string }
 * Returns: raw Anthropic /v1/messages JSON response
 */

export default async function handler(req, res) {
  // Only allow POST
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured on server" });
  }

  const { imageBase64, mediaType, prompt } = req.body;

  if (!imageBase64 || !mediaType || !prompt) {
    return res.status(400).json({ error: "Missing required fields: imageBase64, mediaType, prompt" });
  }

  // Validate base64 size — reject if >5MB decoded to avoid timeouts
  const approxBytes = imageBase64.length * 0.75;
  if (approxBytes > 5 * 1024 * 1024) {
    return res.status(413).json({ error: `Image too large (${Math.round(approxBytes / 1024)}KB). Max 5MB. Try a lower resolution image.` });
  }

  const anthropicBody = {
    model: "claude-sonnet-4-20250514",
    max_tokens: 4000,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type:       "base64",
              media_type: mediaType,
              data:       imageBase64,
            },
          },
          {
            type: "text",
            text: prompt,
          },
        ],
      },
    ],
  };

  try {
    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":         apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(anthropicBody),
    });

    const data = await upstream.json();

    // Forward Anthropic's status code so client can detect errors
    return res.status(upstream.status).json(data);

  } catch (err) {
    console.error("Upstream Anthropic error:", err);
    return res.status(502).json({ error: `Upstream request failed: ${err.message}` });
  }
}
