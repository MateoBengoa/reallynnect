/**
 * Interpreta el texto de hora/fecha que LinkedIn muestra en cada fila del inbox
 * (p. ej. "19 mar", "11:49", "hace 5 min", "ayer"). `reference` debe ser la fecha/hora del scrape (ahora).
 */
export function parseLinkedInInboxListTime(raw: string, reference: Date): string | null {
  const t = raw.replace(/\s+/g, " ").trim();
  if (!t) return null;

  if (/^\d{4}-\d{2}-\d{2}/.test(t)) {
    const d = new Date(t);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  const refMs = reference.getTime();
  const y = reference.getFullYear();
  const low = t.toLowerCase();

  const rel = low.match(/^hace\s+(\d+)\s*(min|minutos|mins|m|h|hora|horas|hr|hrs)\.?$/i);
  if (rel) {
    const n = parseInt(rel[1], 10);
    const d = new Date(refMs);
    const u = rel[2].toLowerCase();
    if (u.startsWith("h")) d.setHours(d.getHours() - n);
    else d.setMinutes(d.getMinutes() - n);
    return d.toISOString();
  }

  if (/^ayer\b/i.test(t) || /^yesterday\b/i.test(t)) {
    const d = new Date(refMs);
    d.setDate(d.getDate() - 1);
    d.setHours(12, 0, 0, 0);
    return d.toISOString();
  }

  const dmY = t.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (dmY) {
    const day = parseInt(dmY[1], 10);
    const month = parseInt(dmY[2], 10) - 1;
    let yr = dmY[3] ? parseInt(dmY[3], 10) : y;
    if (yr < 100) yr += 2000;
    const d = new Date(yr, month, day, 12, 0, 0, 0);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  const hm = t.match(/^(\d{1,2}):(\d{2})(?:\s*[ap]\.?m\.?)?$/i);
  if (hm) {
    const d = new Date(refMs);
    d.setHours(parseInt(hm[1], 10), parseInt(hm[2], 10), 0, 0);
    return d.toISOString();
  }

  const dm = t.match(/^(\d{1,2})\s+([a-záéíóúñ]{3,12})\.?$/i);
  if (dm) {
    const day = parseInt(dm[1], 10);
    const mon = dm[2].toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const prefix3 = mon.slice(0, 3);
    const months: Record<string, number> = {
      ene: 0,
      feb: 1,
      mar: 2,
      abr: 3,
      may: 4,
      jun: 5,
      jul: 6,
      ago: 7,
      sep: 8,
      oct: 9,
      nov: 10,
      dic: 11,
      jan: 0,
      apr: 3,
      aug: 7,
      dec: 11,
    };
    const mo = months[prefix3];
    if (mo === undefined) return null;
    let d = new Date(y, mo, day, 12, 0, 0, 0);
    if (d.getTime() > refMs + 48 * 3600000) d = new Date(y - 1, mo, day, 12, 0, 0, 0);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  return null;
}
