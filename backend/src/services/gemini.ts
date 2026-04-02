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

export type BrainContext = {
  brand_type?:     string;
  company_name?:   string;
  description?:    string;
  products?:       string;
  audience?:       string;
  tone?:           string;
  value_prop?:     string;
  keywords?:       string;
  extra?:          string;
  full_name?:      string;
  personal_role?:  string;
  personal_story?: string;
};

export async function generatePost(topic: string, brain?: BrainContext | null): Promise<{ text: string; imageDescription?: string }> {
  const isPersonal = brain?.brand_type === "personal";
  const brainBlock = brain
    ? isPersonal
      ? `\nPersonal brand context (write in first person, authentic voice):\n` +
        (brain.full_name      ? `- Author: ${brain.full_name}\n` : "") +
        (brain.personal_role  ? `- Role/title: ${brain.personal_role}\n` : "") +
        (brain.personal_story ? `- Personal story/background: ${brain.personal_story}\n` : "") +
        (brain.audience       ? `- Target audience: ${brain.audience}\n` : "") +
        (brain.tone           ? `- Tone/voice: ${brain.tone}\n` : "") +
        (brain.value_prop     ? `- Unique value: ${brain.value_prop}\n` : "") +
        (brain.keywords       ? `- Keywords/hashtags: ${brain.keywords}\n` : "") +
        (brain.extra          ? `- Extra context: ${brain.extra}\n` : "")
      : `\nBusiness context (use this to personalize the post):\n` +
        (brain.company_name ? `- Company: ${brain.company_name}\n` : "") +
        (brain.description  ? `- What we do: ${brain.description}\n` : "") +
        (brain.products     ? `- Products/services: ${brain.products}\n` : "") +
        (brain.audience     ? `- Target audience: ${brain.audience}\n` : "") +
        (brain.tone         ? `- Tone/voice: ${brain.tone}\n` : "") +
        (brain.value_prop   ? `- Value proposition: ${brain.value_prop}\n` : "") +
        (brain.keywords     ? `- Keywords/hashtags: ${brain.keywords}\n` : "") +
        (brain.extra        ? `- Extra context: ${brain.extra}\n` : "")
    : "";

  const prompt = `Generate a professional LinkedIn post about: ${topic}.${brainBlock}
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
 * Usa un template fijo de foto editorial profesional para evitar que el modelo
 * de texto introduzca vocabulario que dispara el estilo sci-fi/neon.
 * Solo varía la acción específica según el tema del post.
 */
export async function generateIllustrationBrief(topic: string, postText: string): Promise<string> {
  const t = (topic + " " + postText).toLowerCase();

  // Mapeo por palabras clave → acción física mundana sin tecnología
  let action: string;
  if (/leader|manag|team|direct|jefe|equipo|gestión|lideraz/.test(t)) {
    action = "writing key points on a large whiteboard with a black marker, turned slightly toward camera";
  } else if (/sales|venta|revenue|deal|cliente|client|negoci/.test(t)) {
    action = "reviewing a printed sales report with a red pen, making notes in the margins";
  } else if (/market|brand|content|creativ|diseño|design|social/.test(t)) {
    action = "sketching a layout on a large sheet of paper with colored markers";
  } else if (/product|eficien|efficien|work|work|tarea|task|focus|produc/.test(t)) {
    action = "organizing a neat stack of documents with a satisfied expression";
  } else if (/growth|crec|strateg|estrateg|plan|goal|objetivo/.test(t)) {
    action = "drawing an upward arrow on a paper diagram laid flat on the desk";
  } else if (/data|analy|analíti|insight|metric|kpi|report/.test(t)) {
    action = "circling important numbers on a printed spreadsheet with a highlighter";
  } else if (/innov|startup|emprend|idea|future|futuro/.test(t)) {
    action = "writing ideas on sticky notes and placing them on a glass wall";
  } else {
    action = "reading a printed document with focused attention, pen in hand";
  }

  // Template fijo — 90% del prompt es constante y probado
  return (
    `Ultra-realistic Getty Images stock photograph. ` +
    `A professional woman in her late 30s wearing a light beige blazer over a white shirt, ` +
    `${action}. ` +
    `Setting: minimalist modern office, large window behind her showing soft morning light, ` +
    `a white ceramic coffee mug and small green succulent on the wooden desk. ` +
    `Background softly blurred (bokeh). ` +
    `Canon EOS R5, 85mm f/1.8 portrait lens, ISO 200. ` +
    `Warm, slightly golden color grading. Natural skin texture visible. ` +
    `Real indoor environment, real human, real physical objects only. ` +
    `NOT an illustration. NOT digital art. NOT cartoon. NOT painting. NOT 3D render. ` +
    `ZERO neon. ZERO glowing effects. ZERO holographic panels. ZERO floating text. ` +
    `ZERO visible computer screens. ZERO sci-fi elements. ZERO blue-purple gradients. ` +
    `ZERO dark dramatic lighting. ZERO abstract backgrounds.`
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

  const ac = new AbortController();
  const tid = setTimeout(() => ac.abort(), 5 * 60 * 1000); // 5 min max

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
  } catch (e) {
    console.error("Gemini image fetch error", e);
    return null;
  } finally {
    clearTimeout(tid);
  }

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
