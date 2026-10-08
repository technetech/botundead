export const STRATEGY = Object.freeze({ symbols: ['BTC', 'ETH', 'SOL'], margin: 25, leverage: 10, timezone: 'America/Monterrey' });
const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: STRATEGY.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
export function localTime(date) {
  const p = Object.fromEntries(formatter.formatToParts(date).map(x => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, seconds: Number(p.hour) * 3600 + Number(p.minute) * 60 + Number(p.second) };
}
export function clock(seconds) {
  return `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds % 3600 / 60)).padStart(2, '0')}`;
}
export function cycleAt(date) {
  const time = localTime(date);
  const open = Math.floor(time.seconds / 7200) * 7200 + 600;
  return { day: time.day, open, close: open + 6000, key: `${time.day}T${clock(open)}` };
}
export function nextOpening(date) {
  let candidate = new Date(date);
  // Advance in real time so Intl remains the authority for the timezone.
  candidate.setUTCSeconds(0, 0);
  for (let i = 0; i <= 24 * 60; i++) {
    const local = localTime(candidate);
    if (candidate > date && local.seconds % 7200 === 600) return candidate.toISOString();
    candidate = new Date(candidate.getTime() + 60000);
  }
  throw new Error('No se encontro el siguiente ciclo');
}
