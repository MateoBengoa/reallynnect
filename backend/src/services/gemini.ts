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
 * Genera el prompt final para el modelo de imagen.
 * Estrategia: el modelo de texto SOLO rellena 3 datos concretos (persona, acción, lugar).
 * El prompt completo con todos los modificadores fotorrealistas se construye aquí,
 * sin dejar que el modelo invente el estilo.
 */
export async function generateIllustrationBrief(topic: string, postText: string): Promise<string> {
  const slotPrompt = `LinkedIn post topic: "${topic}"
Post (excerpt): "${postText.slice(0, 200)}"

Fill in exactly 3 lines. Be concrete. Think of a mundane business moment that SHOWS (not symbolizes) what the post is about.

PERSON: [job title] [gender] [age range] [specific clothing item]
ACTION: [physical verb] [specific physical object]
SETTING: [room type], [one furniture item], [one other detail]

Critical rules:
- No laptops, phones, or visible screens
- No abstract objects (no lightbulbs, brains, networks, gears, globes)
- Just ordinary office reality that any photographer could capture
- The ACTION must be directly related to the post topic

Examples:
Topic "sales strategy" → PERSON: sales manager, man, 40s, navy blazer | ACTION: drawing a funnel diagram on a whiteboard | SETTING: glass-walled meeting room, long table, water glasses
Topic "remote work" → PERSON: freelancer, woman, 30s, oversized grey sweater | ACTION: writing in a notebook with coffee cup beside her | SETTING: home office corner, wooden desk, bookshelf

Output ONLY the 3 lines starting with PERSON:, ACTION:, SETTING:`;

  const raw = (await callGeminiText(slotPrompt)).trim();

  const person  = raw.match(/PERSON:\s*(.+)/i)?.[1]?.trim()  ?? "business professional, gender-neutral, 35, smart casual attire";
  const action  = raw.match(/ACTION:\s*(.+)/i)?.[1]?.trim()  ?? "reviewing a printed report with a pen in hand";
  const setting = raw.match(/SETTING:\s*(.+)/i)?.[1]?.trim() ?? "bright modern office, wooden desk, window with soft light";

  // Construir el prompt final — todos los modificadores de foto los ponemos nosotros
  return (
    `Realistic photograph of a ${person}, ${action}, ${setting}. ` +
    `Soft natural window light from the side, warm neutral tones. ` +
    `Fujifilm GFX 100S, 55mm f/2.8, medium format, ISO 200, very slight film grain. ` +
    `Subject in sharp focus, background gently blurred. ` +
    `Candid, unposed moment. Magazine editorial style. ` +
    `IMPORTANT: real photograph, NOT illustration, NOT digital art, NOT cartoon, NOT concept art. ` +
    `Zero glowing effects, zero holograms, zero floating UI, zero neon, zero circuit patterns, zero sci-fi elements, zero text overlays.`
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
