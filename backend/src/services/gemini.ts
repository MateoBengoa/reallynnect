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
  "imageDescription": "Design a UNIQUE flat-design illustration for this specific post. Rules: (1) Base it on a CONCRETE METAPHOR or specific object directly from the post topic — NOT generic tech imagery. (2) FORBIDDEN: glowing brains, neural networks, circuit boards, blue neon, abstract orbs, generic robots, chip silhouettes, data streams. (3) Describe a simple scene with 2-3 bold flat colors, clean shapes, no gradients. (4) Example for a post about Claude AI: a friendly speech bubble made of building blocks with an 'A' and a 'C' interlocking, warm orange and white palette, minimal background. (5) Include: main object, secondary element, color palette (name the exact colors), composition (centered/left-heavy/etc), and overall mood."
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
 * Extrae 2-3 keywords en inglés para buscar foto en Pexels.
 */
export async function extractSearchKeywords(topic: string, postText: string): Promise<string> {
  const prompt = `LinkedIn post topic: "${topic}"
Post excerpt: "${postText.slice(0, 300)}"

Output 2-3 English search keywords to find a professional stock photo on Pexels.
Rules: concrete nouns only, no adjectives like "professional" or "modern", relevant to the actual subject matter.
Good examples: "team meeting", "data analysis", "remote work collaboration", "startup office", "product launch"
Output ONLY the keywords comma-separated, nothing else.`;
  return (await callGeminiText(prompt)).trim().replace(/['"]/g, "").slice(0, 80);
}

/**
 * Busca una foto de stock profesional en Pexels y devuelve la URL directa.
 * Requiere PEXELS_API_KEY en el entorno.
 */
export async function fetchPexelsPhotoUrl(keywords: string): Promise<string | null> {
  const key = process.env.PEXELS_API_KEY;
  if (!key) return null;
  try {
    const q = encodeURIComponent(keywords);
    const res = await fetch(
      `https://api.pexels.com/v1/search?query=${q}&per_page=10&orientation=landscape&size=large`,
      { headers: { Authorization: key } }
    );
    if (!res.ok) return null;
    const data = await res.json() as {
      photos?: Array<{ src: { large2x?: string; large?: string } }>;
    };
    const photos = data.photos ?? [];
    if (!photos.length) return null;
    // Elegir una al azar entre las primeras 5 para variedad
    const pick = photos[Math.floor(Math.random() * Math.min(photos.length, 5))];
    return pick?.src.large2x ?? pick?.src.large ?? null;
  } catch {
    return null;
  }
}

/**
 * Convierte un tema + texto de post en un brief de ilustración que evita
 * clichés de IA/tech usando metáforas cotidianas y colores cálidos.
 */
export async function generateIllustrationBrief(topic: string, postText: string): Promise<string> {
  const prompt = `You are a creative director at a design studio. Your job: translate ANY business topic into a warm, everyday illustration concept — never show the technology itself.

Topic: "${topic}"
Post excerpt: "${postText.slice(0, 400)}"

Write a 2-sentence illustration brief. Rules you MUST follow:
1. Use ONLY everyday objects as metaphors: books, plants, hands, paths, doors, keys, bridges, seeds, lanterns, maps, conversations, seasons, kitchens, gardens, workshops — NEVER robots, brains, circuits, screens, chips, code, servers, or any tech hardware.
2. Color palette: warm and inviting — oranges, earth tones, soft greens, cream, warm blues. NO dark backgrounds, NO neon, NO glows.
3. Style: simple flat 2D like Duolingo or Mailchimp — bold shapes, solid fills, no gradients.
4. Output ONLY the 2-sentence brief. No intro, no labels, no markdown.

Example output for "AI productivity tools":
"A person in a cozy workshop organizing colorful building blocks into a neat tower, while a small owl perches nearby holding a checklist. Warm terracotta, cream, and forest green palette; flat geometric shapes on a light background."`;

  const brief = await callGeminiText(prompt);
  return brief.trim().slice(0, 600);
}

export async function generateImageBytes(imagePrompt: string): Promise<Buffer | null> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;

  const model = process.env.GEMINI_IMAGE_MODEL ?? DEFAULT_MODEL;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;

  const fullPrompt = [
    "Flat 2D illustration for LinkedIn. Scene:",
    imagePrompt,
    "Style: flat design, solid colors, bold simple shapes, like Duolingo or Mailchimp illustrations.",
    "Background: solid light pastel or white.",
    "NO: text, labels, numbers, gradients, glows, shadows, dark backgrounds, human faces, robots, circuit boards, neural networks, neon effects.",
  ].join(" ");

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
