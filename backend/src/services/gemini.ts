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
  "imageDescription": "A short visual concept for the post. Choose ONE of these styles: (A) Real-world photo of 1-2 professionals in a modern office/meeting, (B) Clean modern digital art or infographic with a professional color palette, (C) A clean diagram or flowchart. NEVER use: neon glows, holographic UI, sci-fi circuits, comic/cartoon characters, or overly saturated blue-purple futuristic palettes."
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

/**
 * Genera el prompt de imagen.
 * El modelo de texto SOLO responde "qué hace la persona" (verbo + objeto físico).
 * Todo lo demás (cámara, luz, persona, negativas) lo construimos en código.
 */
export async function generateIllustrationBrief(topic: string, postText: string): Promise<string> {
  // Solo pedimos UNA cosa: qué acción física muestra el beneficio del post
  const actionPrompt = `LinkedIn post about: "${topic}"
Post: "${postText.slice(0, 150)}"

What is ONE physical, real-world action a professional person would do that REPRESENTS the benefit of this post?
The action must use ONLY physical objects: paper, pen, whiteboard, notebook, coffee mug, printed documents, books.
NEVER use: laptop, phone, screen, computer, keyboard, digital, AI, data, virtual.

Example for "AI productivity": "signing off on a finished project document, smiling"
Example for "leadership": "pointing at a section of a printed roadmap on a table"
Example for "sales": "drawing an upward arrow on a whiteboard with a marker"

Answer with ONLY the action in 5-10 words. No explanation.`;

  const action = (await callGeminiText(actionPrompt)).trim().slice(0, 120);

  // Construimos el prompt completo nosotros — modelo de texto NO toca el estilo
  return (
    `Hyperrealistic DSLR photograph. ` +
    `A professional person in their late 30s wearing a plain blazer, ${action}, ` +
    `inside a minimalist modern office with large windows, wooden furniture, soft plants. ` +
    `Warm natural afternoon light streaming from the left. ` +
    `Captured on Canon EOS R5, 85mm f/1.4 lens, ISO 320, shallow depth of field, ` +
    `bokeh background, skin texture visible, photojournalism style. ` +
    `Color grading: warm tones, slightly desaturated, clean whites. ` +
    `The person looks calm and focused. ` +
    `Style: real photograph as it would appear in Forbes or Harvard Business Review. ` +
    `STRICT: no illustration, no painting, no digital art, no cartoon, no 3D render, ` +
    `no neon colors, no glowing elements, no holographic interfaces, no floating text, ` +
    `no circuit boards, no sci-fi elements, no blue-purple gradients, no dark dramatic lighting. ` +
    `Background is a real physical office space, not abstract.`
  );
}

export async function generateImageBytes(imagePrompt: string): Promise<Buffer | null> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;

  // Usar el modelo dedicado de imagen; fallback a gemini-2.0-flash-preview-image-generation
  const model = process.env.GEMINI_IMAGE_MODEL ?? "gemini-3.1-flash-image-preview";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;

  const body = {
    contents: [{ parts: [{ text: `Generate a REALISTIC PHOTOGRAPH (not an illustration, not digital art, not cartoon): ${imagePrompt}` }] }],
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
