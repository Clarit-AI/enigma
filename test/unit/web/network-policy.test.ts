import { describe, expect, it } from 'vitest';
import { decideInsecureHttpPolicy, isLocalhostBinding, isTailscaleHost } from '../../../src/web/network-policy.js';

describe('isLocalhostBinding', () => {
  it.each(['localhost', '127.0.0.1', '::1'])('treats %s as localhost', (host) => {
    expect(isLocalhostBinding(host)).toBe(true);
  });

  it('does not treat an arbitrary LAN address as localhost', () => {
    expect(isLocalhostBinding('192.168.1.10')).toBe(false);
  });
});

describe('isTailscaleHost', () => {
  it('recognizes a .ts.net MagicDNS name', () => {
    expect(isTailscaleHost('my-machine.tailnet-name.ts.net')).toBe(true);
  });

  it('recognizes the Tailscale CGNAT range 100.64.0.0/10', () => {
    expect(isTailscaleHost('100.64.0.1')).toBe(true);
    expect(isTailscaleHost('100.127.255.255')).toBe(true);
  });

  it('rejects addresses outside the CGNAT range', () => {
    expect(isTailscaleHost('100.63.255.255')).toBe(false);
    expect(isTailscaleHost('100.128.0.0')).toBe(false);
  });

  it('rejects an ordinary public or LAN address', () => {
    expect(isTailscaleHost('8.8.8.8')).toBe(false);
    expect(isTailscaleHost('192.168.1.10')).toBe(false);
  });

  it('rejects a non-IP, non-.ts.net hostname', () => {
    expect(isTailscaleHost('example.com')).toBe(false);
  });

  it('rejects an IPv6 address', () => {
    expect(isTailscaleHost('::1')).toBe(false);
  });
});

describe('decideInsecureHttpPolicy', () => {
  it('allows localhost with reason "localhost"', () => {
    expect(decideInsecureHttpPolicy('127.0.0.1', false)).toEqual({ allow: true, reason: 'localhost' });
  });

  it('allows a tailscale host with reason "tailscale"', () => {
    expect(decideInsecureHttpPolicy('100.64.0.1', false)).toEqual({ allow: true, reason: 'tailscale' });
  });

  it('allows a non-local host only when override is set, with reason "override"', () => {
    expect(decideInsecureHttpPolicy('192.168.1.10', true)).toEqual({ allow: true, reason: 'override' });
  });

  it('refuses a non-local host without override, with reason "refuse"', () => {
    expect(decideInsecureHttpPolicy('192.168.1.10', false)).toEqual({ allow: false, reason: 'refuse' });
  });
});
