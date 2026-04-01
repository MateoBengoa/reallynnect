const DEFAULT_MODEL =
  process.env.GEMINI_MODEL ?? "gemini-2.0-flash";

export type LeadContext = {
  name?: string;
  company?: string;
  title?: string;
  objective?: string;
};

export async function generateConnectionMessage(ctx: LeadContext): Promise<string> {
  const prompt = `Write a short LinkedIn connection message.
Context:
Name: ${ctx.name ?? ""}
Company: ${ctx.company ?? ""}
Title: ${ctx.title ?? ""}
Goal: ${ctx.objective ?? "start a conversation"}
Limit: 250 characters. Output only the message text, no quotes.`;

  const text = await callGeminiText(prompt);
  return text.slice(0, 250);
}

export async function generateDmReply(keyword: string, snippet: string): Promise<string> {
  const prompt = `The user received a LinkedIn DM mentioning "${keyword}". Snippet: "${snippet.slice(0, 500)}".
Write a short helpful professional reply under 400 characters. Output only the reply.`;
  return (await callGeminiText(prompt)).slice(0, 400);
}

export async function generatePost(topic: string): Promise<{ text: string; imageDescription?: string }> {
  const prompt = `Generate a professional LinkedIn post about: ${topic}.
Tone: thought leadership, educational, engaging.
Return JSON only (no markdown fences):
{
  "post": "the full post text",
  "imageDescription": "A detailed visual scene for a LinkedIn illustration DIRECTLY inspired by the post content and key ideas. Describe: specific objects or metaphors that appear in the post, the color palette (professional, 2-3 colors), style (flat design, minimal, clean lines), mood and composition. The scene must visually represent the core message, NOT a generic business image. No people faces, no text or logos in the image."
}`;
  const raw = await callGeminiText(prompt);
  try {
    const j = JSON.parse(raw.replace(/^```json\s*|\s*```$/g, "")) as {
      post?: string;
      imageDescription?: string;
    };
    return { text: j.post ?? raw, imageDescription: j.imageDescription };
  } catch {
    return { text: raw.slice(0, 3000) };
  }
}

export async function generateImageBytes(imagePrompt: string): Promise<Buffer | null> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;

  const model = process.env.GEMINI_IMAGE_MODEL ?? DEFAULT_MODEL;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;

  const fullPrompt = [
    "Create a professional LinkedIn post illustration with these exact specifications:",
    imagePrompt,
    "Additional requirements: flat design style, clean minimal composition, no human faces, absolutely no text or watermarks, suitable for a B2B professional audience, high contrast, print-quality.",
  ].join("\n");

  const body = {
    contents: [
      {
        parts: [{ text: fullPrompt }],
      },
    ],
    generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const t = await res.text();
    console.error("Gemini image error", res.status, t.slice(0, 500));
    return null;
  }

  const data = (await res.json()) as {
    candidates?: Array<{
      content?: { parts?: Array<{ inlineData?: { data?: string; mimeType?: string } }> };
    }>;
  };

  const parts = data.candidates?.[0]?.content?.parts ?? [];
  for (const p of parts) {
    if (p.inlineData?.data) {
      return Buffer.from(p.inlineData.data, "base64");
    }
  }
  return null;
}

async function callGeminiText(prompt: string): Promise<string> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY not set");

  const model = DEFAULT_MODEL;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
    }),
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Gemini API ${res.status}: ${t.slice(0, 200)}`);
  }

  const data = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ?? "";
  return text.trim();
}
