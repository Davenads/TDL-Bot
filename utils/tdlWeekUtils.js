/**
 * Utility functions for TDL registration-window and week calculations.
 *
 * TDL event:            Mondays 6:00 PM ET (~4 hours).
 * Registration window:  Opens Tuesday 12:00 AM ET, closes Sunday 11:59 PM ET.
 *                       All day Monday is CLOSED so Toeshank can build the
 *                       matchups from the signups and run the event.
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
 * Open Tuesday 12:00 AM ET through Sunday 11:59 PM ET; closed all day Monday.
 * @returns {boolean}
 */
function isRegistrationOpen() {
    const day = nowET().getDay();
    // Closed only on Monday (event/organize day). Open Tue..Sun.
    return day !== 1;
}

/**
 * Start of the current registration cycle: most recent Tuesday 12:00 AM ET.
 * Used to scope "current week" signups for dedupe and recent-signup views.
 * @returns {Date}
 */
function getWeekStartDate() {
    const now = nowET();
    const day = now.getDay();
    // Days back to the most recent Tuesday. Sun(0)->5, Mon(1)->6, Tue(2)->0, ...
    const daysSinceTuesday = day >= 2 ? day - 2 : day + 5;
    const start = new Date(now);
    start.setDate(now.getDate() - daysSinceTuesday);
    start.setHours(0, 0, 0, 0);
    return start;
}

/**
 * The event date this registration cycle points at: upcoming Monday 6:00 PM ET.
 * On Monday itself, returns today at 6:00 PM ET.
 * @returns {Date}
 */
function getCurrentEventDate() {
    const now = nowET();
    const day = now.getDay();
    const daysUntilMonday = (1 - day + 7) % 7; // 0 if already Monday
    const event = new Date(now);
    event.setDate(now.getDate() + daysUntilMonday);
    event.setHours(18, 0, 0, 0);
    return event;
}

/**
 * Human-friendly event date, e.g. "Monday, August 31".
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
 * @returns {Array<Array<string>>}
 */
function filterCurrentWeekSignups(rows, skipHeader = true) {
    const weekStart = getWeekStartDate();
    const startIndex = skipHeader ? 1 : 0;
    return (rows || []).slice(startIndex).filter(row => {
        if (!row || !row[0]) return false;
        const d = new Date(row[0]);
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
    isRegistrationOpen,
    getWeekStartDate,
    getCurrentEventDate,
    getEventDateString,
    filterCurrentWeekSignups,
    formatSheetTimestamp
};
