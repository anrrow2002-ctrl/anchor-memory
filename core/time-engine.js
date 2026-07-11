const UNKNOWN_RE = /^(?:未明|未知|不详|无法判断|暂无|无)$/i;
const FLASHBACK_RE = /(回忆|梦境|幻觉|设想|假设|转述|过去|此前|曾经|当年|记忆中|flashback|dream)/i;
const FORWARD_RE = /(次日|翌日|第二天|隔天|几天后|一周后|数周后|一个月后|后来|随后|之后|当晚|翌晨)/i;

const DAYPARTS = [
  ['凌晨', 2], ['黎明', 5], ['清晨', 7], ['早晨', 8], ['上午', 10], ['中午', 12],
  ['下午', 15], ['傍晚', 18], ['晚上', 20], ['夜晚', 21], ['深夜', 23],
];

function pad(value, length = 2) {
  return String(value).padStart(length, '0');
}

export function normalizeNarrativeTime(raw) {
  const text = String(raw || '').trim().replace(/\s+/g, ' ');
  if (!text || UNKNOWN_RE.test(text)) return { raw: text || '未明', kind: 'unknown', comparable: false, confidence: 0 };

  const full = text.match(/(?:(\d{4})\s*[年\-/\.])?\s*(\d{1,2})\s*[月\-/\.]\s*(\d{1,2})\s*(?:日|号)?(?:[^\d]{0,6}(\d{1,2})\s*[:：时]\s*(\d{1,2})?)?/);
  if (full) {
    const year = full[1] ? Number(full[1]) : null;
    const month = Number(full[2]);
    const day = Number(full[3]);
    const hour = full[4] !== undefined ? Number(full[4]) : null;
    const minute = full[5] !== undefined && full[5] !== '' ? Number(full[5]) : 0;
    const valid = month >= 1 && month <= 12 && day >= 1 && day <= 31
      && (hour === null || (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59));
    if (valid) {
      const sortKey = Number(`${pad(year ?? 0, 4)}${pad(month)}${pad(day)}${pad(hour ?? 0)}${pad(minute)}`);
      return { raw: text, kind: year ? 'absolute-date' : 'month-day', comparable: !!year, year, month, day, hour, minute, sortKey, confidence: year ? 1 : 0.72 };
    }
  }

  const clock = text.match(/(?:^|\D)(\d{1,2})\s*[:：时]\s*(\d{1,2})?(?:分)?/);
  if (clock) {
    const hour = Number(clock[1]);
    const minute = clock[2] ? Number(clock[2]) : 0;
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      return { raw: text, kind: 'clock', comparable: true, hour, minute, sortKey: hour * 60 + minute, confidence: 0.82 };
    }
  }

  for (const [label, hour] of DAYPARTS) {
    if (text.includes(label)) return { raw: text, kind: 'daypart', comparable: true, hour, minute: 0, sortKey: hour * 60, confidence: 0.56 };
  }

  if (FORWARD_RE.test(text)) return { raw: text, kind: 'relative-forward', comparable: false, direction: 1, confidence: 0.6 };
  return { raw: text, kind: 'label', comparable: false, confidence: 0.35 };
}


function inheritedDateLabel(previousRaw, nextRaw) {
  const previous = normalizeNarrativeTime(previousRaw);
  const nextText = String(nextRaw || '').trim();
  const next = normalizeNarrativeTime(nextText);
  if (!previousRaw || !nextText || next.kind === 'absolute-date' || next.kind === 'month-day') return nextText;
  if (!['absolute-date', 'month-day'].includes(previous.kind)) return nextText;
  const hasTimeDetail = ['clock', 'daypart'].includes(next.kind) || DAYPARTS.some(([label]) => nextText.includes(label));
  if (!hasTimeDetail) return nextText;

  let year = previous.year;
  let month = previous.month;
  let day = previous.day;
  if (/(次日|翌日|第二天|隔天|翌晨)/.test(nextText)) {
    if (year) {
      const date = new Date(Date.UTC(year, month - 1, day + 1));
      year = date.getUTCFullYear();
      month = date.getUTCMonth() + 1;
      day = date.getUTCDate();
    } else {
      day += 1;
    }
  }
  const dateLabel = year ? `${year}年${month}月${day}日` : `${month}月${day}日`;
  return `${dateLabel} ${nextText.replace(/^(?:次日|翌日|第二天|隔天|翌晨)\s*/, '')}`.trim();
}

export function compareNarrativeTimes(previousRaw, nextRaw, sourceText = '') {
  const previous = normalizeNarrativeTime(previousRaw);
  const next = normalizeNarrativeTime(nextRaw);
  const source = String(sourceText || '');
  if (FLASHBACK_RE.test(source) || FLASHBACK_RE.test(next.raw)) {
    return { order: 'flashback', previous, next, warning: '' };
  }
  if (FORWARD_RE.test(source) || FORWARD_RE.test(next.raw)) return { order: 'forward', previous, next, warning: '' };
  if (next.kind === 'relative-forward') return { order: 'forward', previous, next, warning: '' };
  if (!previous.comparable || !next.comparable) return { order: 'unknown', previous, next, warning: '' };
  if (previous.kind !== next.kind && !(previous.kind === 'absolute-date' && next.kind === 'absolute-date')) {
    return { order: 'unknown', previous, next, warning: '' };
  }
  if (next.sortKey > previous.sortKey) return { order: 'forward', previous, next, warning: '' };
  if (next.sortKey === previous.sortKey) return { order: 'same', previous, next, warning: '' };
  return {
    order: 'backward',
    previous,
    next,
    warning: `剧情时间可能倒退：上一有效时间“${previous.raw}”，本楼时间“${next.raw}”。若本楼是回忆/梦境，请在摘要中明确标注。`,
  };
}

export function rebuildTimelineState(entries = [], manual = {}) {
  const history = [];
  const warnings = [];
  let currentRaw = String(manual.currentTime || '').trim();
  let currentSourceKey = manual.sourceKey || '';
  let currentFloor = Number.isFinite(Number(manual.floor)) ? Number(manual.floor) : -1;

  for (const entry of entries || []) {
    const raw = String(entry?.time || '').trim();
    if (!raw || UNKNOWN_RE.test(raw)) continue;
    const sourceText = `${entry?.title || ''}\n${entry?.body || ''}`;
    const resolvedRaw = currentRaw ? inheritedDateLabel(currentRaw, raw) : raw;
    const comparison = currentRaw ? compareNarrativeTimes(currentRaw, resolvedRaw, sourceText) : { order: 'unknown' };
    const flashback = comparison.order === 'flashback';
    if (comparison.warning) warnings.push({ floor: entry.floor ?? -1, key: entry.key || '', message: comparison.warning });
    history.push({
      key: entry.key || '', floor: entry.floor ?? -1, raw, resolvedRaw, kind: normalizeNarrativeTime(resolvedRaw).kind,
      order: comparison.order || 'unknown', flashback,
    });
    if (!flashback && comparison.order !== 'backward') {
      currentRaw = resolvedRaw;
      currentSourceKey = entry.key || currentSourceKey;
      currentFloor = Number.isFinite(Number(entry.floor)) ? Number(entry.floor) : currentFloor;
    }
  }

  return {
    currentRaw: currentRaw || '未明',
    currentSourceKey,
    currentFloor,
    warnings: warnings.slice(-20),
    history: history.slice(-120),
    updatedAt: Date.now(),
  };
}

export function isExplicitFlashback(text) {
  return FLASHBACK_RE.test(String(text || ''));
}
