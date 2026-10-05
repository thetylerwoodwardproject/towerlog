import { describe, expect, it } from 'vitest';
import { crossSite, parseCookies, rateLimitKey } from '../src/engine/auth.ts';
import { safeNext } from '../src/lib/redirect.ts';

describe('parseCookies', () => {
  it('decodes values and never throws on bad escapes', () => {
    expect(parseCookies('a=1; b=x%20y')).toEqual({ a: '1', b: 'x y' });
    expect(parseCookies('towerlog_session=%E0%A4%A; ok=1')).toEqual({ towerlog_session: '%E0%A4%A', ok: '1' });
    expect(parseCookies('a=%')).toEqual({ a: '%' });
    expect(parseCookies(undefined)).toEqual({});
  });
});

describe('safeNext', () => {
  it('allows local paths only', () => {
    expect(safeNext('/config?tab=smtp')).toBe('/config?tab=smtp');
    expect(safeNext(null)).toBe('/');
    for (const bad of ['https://evil.example', '//evil.example', '/\\evil.example', '/\t/evil.example', '/\n/evil.example', 'javascript:alert(1)', '']) {
      expect(safeNext(bad)).toBe('/');
    }
  });
});

describe('crossSite', () => {
  it('lets same-origin pages and non-browser clients through', () => {
    expect(crossSite('http://pi:8090', 'same-origin', 'pi:8090')).toBe(false);
    expect(crossSite('https://pi.example', 'same-origin', 'pi.example')).toBe(false); // TLS proxy in front
    expect(crossSite(null, null, 'pi:8090')).toBe(false);
  });
  it('refuses other pages, including other ports on the same host', () => {
    expect(crossSite('http://pi:8000', 'same-site', 'pi:8090')).toBe(true);
    expect(crossSite('http://pi:8000', null, 'pi:8090')).toBe(true);
    expect(crossSite(null, 'cross-site', 'pi:8090')).toBe(true);
    expect(crossSite('null', null, 'pi:8090')).toBe(true);
  });
});

describe('rateLimitKey', () => {
  it('groups IPv6 by /64', () => {
    expect(rateLimitKey('192.0.2.7')).toBe('192.0.2.7');
    expect(rateLimitKey('::ffff:192.0.2.7')).toBe('192.0.2.7');
    expect(rateLimitKey('2001:db8:0:1::5')).toBe(rateLimitKey('2001:0db8:0000:0001:ffff:1:2:3'));
    expect(rateLimitKey('2001:db8:0:1::5')).not.toBe(rateLimitKey('2001:db8:0:2::5'));
  });
});
