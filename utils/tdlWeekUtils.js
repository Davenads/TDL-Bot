/**
 * Utility functions for TDL registration-window and week calculations.
 *
 * TDL event:            Tuesdays 6:00 PM ET (~4 hours).
 * Registration window:  Opens Wednesday 12:00 AM ET, closes Monday 7:00 PM ET.
 *                       Closed from Monday 7 PM through all of Tuesday so Toeshank
 *                       can build the fight card and run the event.
 *
 * Day indices (JS getDay): 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat.
 */

const TIME_ZONE = 'America/New_York';

/**
 * Current time expressed as ET wall-clock (fields read via getDay/getHours are ET).
 * @returns {Date}
 */
function nowET() {
    return new Date(new Date().toLocaleString('en-US', { timeZone: TIME_ZONE }));
}

/**
 * Is registration currently open?
 * Open Wednesday 12:00 AM ET through Monday 7:00 PM ET; closed from Monday 7 PM
 * through all of Tuesday (the event/organize day).
 * @param {Date} [now] - Injectable clock for testing (defaults to ET now).
 * @returns {boolean}
 */
function isRegistrationOpen(now = nowET()) {
    const day = now.getDay();
    if (day === 2) return false;                         // Tuesday: event day, closed all day
    if (day === 1 && now.getHours() >= 19) return false; // Monday: closes 7:00 PM ET
    return true;                                         // Wed–Sun open; Mon open until 19:00
}

/**
 * Start of the current registration cycle: most recent Wednesday 12:00 AM ET.
 * Used to scope "current week" signups for dedupe and recent-signup views.
 * @param {Date} [now] - Injectable clock for testing (defaults to ET now).
 * @returns {Date}
 */
function getWeekStartDate(now = nowET()) {
    const day = now.getDay();
    // Days back to the most recent Wednesday. Sun(0)->4, Mon(1)->5, Tue(2)->6, Wed(3)->0, ...
    const daysSinceWednesday = day >= 3 ? day - 3 : day + 4;
    const start = new Date(now);
    start.setDate(now.getDate() - daysSinceWednesday);
    start.setHours(0, 0, 0, 0);
    return start;
}

/**
 * The event date this registration cycle points at: upcoming Tuesday 6:00 PM ET.
 * On Tuesday itself, returns today at 6:00 PM ET.
 * @param {Date} [now] - Injectable clock for testing (defaults to ET now).
 * @returns {Date}
 */
function getCurrentEventDate(now = nowET()) {
    const day = now.getDay();
    const daysUntilTuesday = (2 - day + 7) % 7; // 0 if already Tuesday
    const event = new Date(now);
    event.setDate(now.getDate() + daysUntilTuesday);
    event.setHours(18, 0, 0, 0);
    return event;
}

/**
 * Human-friendly event date, e.g. "Tuesday, August 31".
 * @returns {string}
 */
function getEventDateString() {
    return getCurrentEventDate().toLocaleDateString('en-US', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        timeZone: TIME_ZONE
    });
}

/**
 * Filter sheet rows to only those in the current registration week.
 * @param {Array<Array<string>>} rows - Rows from the Registration tab
 * @param {boolean} skipHeader - Skip the first (header) row. Default true.
 * @param {number} tsIndex - Column index holding the timestamp. Default 0.
 *   The Discord Registration tab keeps Status in column A, so its timestamp is
 *   in column B (index 1); callers pass COL.TIMESTAMP for that layout.
 * @returns {Array<Array<string>>}
 */
function filterCurrentWeekSignups(rows, skipHeader = true, tsIndex = 0) {
    const weekStart = getWeekStartDate();
    const startIndex = skipHeader ? 1 : 0;
    return (rows || []).slice(startIndex).filter(row => {
        if (!row || !row[tsIndex]) return false;
        const d = new Date(row[tsIndex]);
        return !isNaN(d.getTime()) && d >= weekStart;
    });
}

/**
 * Format a timestamp to match the retired Google Form's Sheets-native format,
 * e.g. "8/31/2026 18:05:03" (ET, 24-hour, no leading zeros on M/D/H).
 * Keeping this format lets the Looker Studio report parse the column unchanged.
 * @param {Date} date
 * @returns {string}
 */
function formatSheetTimestamp(date = new Date()) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: TIME_ZONE,
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    }).formatToParts(date);

    const p = {};
    for (const part of parts) p[part.type] = part.value;
    const hour = p.hour === '24' ? '0' : p.hour; // guard midnight edge case
    return `${p.month}/${p.day}/${p.year} ${hour}:${p.minute}:${p.second}`;
}

module.exports = {
    TIME_ZONE,
    nowET,
    isRegistrationOpen,
    getWeekStartDate,
    getCurrentEventDate,
    getEventDateString,
    filterCurrentWeekSignups,
    formatSheetTimestamp
};
