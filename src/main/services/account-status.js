// A League (or account-wide) ban from the Riot Client's user info
// (/riot-client-auth/v1/userinfo): { permanent, until } or null. The user info
// can arrive as an object, a JSON string, { userInfo: "<json>" } or a JWT; a
// restriction looks like { type: 'TIME_BAN'|'PERMANENT_BAN', scope: 'lol'|'riot',
// dat: { expirationMillis } }. Chat restrictions and other games are ignored.
function decodeUserInfo(info) {
    let u = info;
    const fromJson = (s) => { try { return JSON.parse(s); } catch { return null; } };
    if (typeof u === 'string') {
        const parts = u.split('.');
        u = parts.length === 3 && !u.trim().startsWith('{')
            ? fromJson(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
            : fromJson(u);
    }
    if (u && typeof u.userInfo === 'string') u = fromJson(u.userInfo);
    return u && typeof u === 'object' ? u : null;
}

function parseBan(info) {
    const scopes = ['lol', 'riot'];
    const u = decodeUserInfo(info);
    const list = u?.ban?.restrictions;
    if (!Array.isArray(list)) return u ? null : undefined;
    let best = null;
    for (const r of list) {
        const type = String(r?.type || '').toUpperCase();
        const scope = String(r?.scope || '').toLowerCase();
        if (!type.includes('BAN') || (scope && !scopes.includes(scope))) continue;
        if (type.includes('PERMANENT')) return { permanent: true, until: null };
        const exp = r?.dat?.expirationMillis ?? r?.dat?.expiration ?? r?.expirationMillis;
        const until = typeof exp === 'number' ? exp : Date.parse(exp);
        if (Number.isFinite(until) && (!best || until > best.until)) best = { permanent: false, until };
    }
    return best;
}


module.exports = { decodeUserInfo, parseBan };
