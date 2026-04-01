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
 * Genera un art direction brief en inglés para la imagen del post.
 * Usa metáforas concretas y referencias de estilo (Airbnb/Stripe/Headspace)
 * para que el modelo de imagen no caiga en el estilo sci-fi por defecto.
 */
export async function generateIllustrationBrief(topic: string, postText: string): Promise<string> {
  const prompt = `You are an art director creating a LinkedIn post illustration brief.

Topic: "${topic}"
Post excerpt: "${postText.slice(0, 400)}"

Write a single-paragraph image prompt (max 120 words) for an AI image generator. Requirements:
- Choose ONE specific scene with 2-3 concrete objects that metaphorically represent the post's core idea
- Objects must be from everyday life: people, furniture, plants, books, tools, food, architecture, nature — never AI hardware, chips, circuits, code, or glowing brains
- Specify the exact art style: "flat vector illustration in the style of Airbnb or Stripe design system" OR "isometric illustration like Headspace app" OR "minimal editorial illustration like The Economist cover"
- Name the exact 3 colors (hex or color names): warm and professional palette
- Lighting: soft and even, no dramatic effects
- End with: "White background. No text. No faces."

Output ONLY the prompt paragraph, nothing else.`;

  return (await callGeminiText(prompt)).trim().slice(0, 700);
}

export async function generateImageBytes(imagePrompt: string): Promise<Buffer | null> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;

  // Usar el modelo dedicado de imagen; fallback a gemini-2.0-flash-preview-image-generation
  const model = process.env.GEMINI_IMAGE_MODEL ?? "gemini-2.0-flash-preview-image-generation";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;

  const body = {
    contents: [{ parts: [{ text: imagePrompt }] }],
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
