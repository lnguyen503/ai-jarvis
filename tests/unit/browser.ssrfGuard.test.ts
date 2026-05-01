/**
 * Tests for src/browser/ssrfGuard.ts — schema rejection, private-IP
 * rejection, deny-host glob, good-URL pass-through. Every path uses the
 * injectable DNS resolver so no network calls happen.
 */
import { describe, it, expect } from 'vitest';
import {
  assertUrlIsSafe,
  isPublicIp,
  matchHostGlob,
  SsrfBlockedError,
} from '../../src/browser/ssrfGuard.js';

const publicResolve = async (): Promise<string[]> => ['8.8.8.8'];

describe('ssrfGuard', () => {
  describe('scheme rejection', () => {
    it('rejects file://', async () => {
      await expect(
        assertUrlIsSafe('file:///etc/passwd', { resolve: publicResolve }),
      ).rejects.toBeInstanceOf(SsrfBlockedError);
    });
    it('rejects data:', async () => {
      await expect(
        assertUrlIsSafe('data:text/html,<h1>x</h1>', { resolve: publicResolve }),
      ).rejects.toBeInstanceOf(SsrfBlockedError);
    });
    it('rejects javascript:', async () => {
      await expect(
        assertUrlIsSafe('javascript:alert(1)', { resolve: publicResolve }),
      ).rejects.toBeInstanceOf(SsrfBlockedError);
    });
    it('rejects ftp://', async () => {
      await expect(
        assertUrlIsSafe('ftp://example.com/', { resolve: publicResolve }),
      ).rejects.toBeInstanceOf(SsrfBlockedError);
    });
    it('accepts http://', async () => {
      const out = await assertUrlIsSafe('http://example.com/', { resolve: publicResolve });
      expect(out).toContain('example.com');
    });
    it('accepts https://', async () => {
      const out = await assertUrlIsSafe('https://example.com/path?x=1', {
        resolve: publicResolve,
      });
      expect(out).toContain('https://');
    });
  });

  describe('private IP literal rejection', () => {
    it('rejects 127.0.0.1', async () => {
      await expect(
        assertUrlIsSafe('http://127.0.0.1/', { resolve: publicResolve }),
      ).rejects.toMatchObject({ reason: 'private-ip-literal' });
    });
    it('rejects 10.x.x.x', async () => {
      await expect(
        assertUrlIsSafe('http://10.1.2.3/', { resolve: publicResolve }),
      ).rejects.toMatchObject({ reason: 'private-ip-literal' });
    });
    it('rejects 172.16.x.x', async () => {
      await expect(
        assertUrlIsSafe('http://172.16.0.1/', { resolve: publicResolve }),
      ).rejects.toMatchObject({ reason: 'private-ip-literal' });
    });
    it('rejects 172.31.x.x (upper bound of RFC 1918 /12)', async () => {
      await expect(
        assertUrlIsSafe('http://172.31.255.254/', { resolve: publicResolve }),
      ).rejects.toMatchObject({ reason: 'private-ip-literal' });
    });
    it('accepts 172.32.x.x (just outside /12)', async () => {
      await expect(
        assertUrlIsSafe('http://172.32.0.1/', { resolve: publicResolve }),
      ).resolves.toBeTruthy();
    });
    it('rejects 192.168.x.x', async () => {
      await expect(
        assertUrlIsSafe('http://192.168.1.1/', { resolve: publicResolve }),
      ).rejects.toMatchObject({ reason: 'private-ip-literal' });
    });
    it('rejects 169.254.169.254 (cloud metadata)', async () => {
      await expect(
        assertUrlIsSafe('http://169.254.169.254/latest/meta-data/', {
          resolve: publicResolve,
        }),
      ).rejects.toMatchObject({ reason: 'private-ip-literal' });
    });
    it('rejects 0.0.0.0', async () => {
      await expect(
        assertUrlIsSafe('http://0.0.0.0/', { resolve: publicResolve }),
      ).rejects.toMatchObject({ reason: 'private-ip-literal' });
    });
    it('rejects IPv6 ::1', async () => {
      await expect(
        assertUrlIsSafe('http://[::1]/', { resolve: publicResolve }),
      ).rejects.toMatchObject({ reason: 'private-ip-literal' });
    });
    it('rejects IPv6 fd00:: (unique-local)', async () => {
      await expect(
        assertUrlIsSafe('http://[fd00::1]/', { resolve: publicResolve }),
      ).rejects.toMatchObject({ reason: 'private-ip-literal' });
    });
    it('rejects IPv4-mapped v6 ::ffff:10.0.0.1', async () => {
      await expect(
        assertUrlIsSafe('http://[::ffff:10.0.0.1]/', { resolve: publicResolve }),
      ).rejects.toMatchObject({ reason: 'private-ip-literal' });
    });
  });

  describe('DNS rebinding defence', () => {
    it('rejects when resolver returns a private IP', async () => {
      await expect(
        assertUrlIsSafe('http://evil.example/', {
          resolve: async () => ['127.0.0.1'],
        }),
      ).rejects.toMatchObject({ reason: 'private-ip-resolved' });
    });
    it('rejects when ANY resolved IP is private (multi-record)', async () => {
      await expect(
        assertUrlIsSafe('http://sneaky.example/', {
          resolve: async () => ['8.8.8.8', '10.0.0.1'],
        }),
      ).rejects.toMatchObject({ reason: 'private-ip-resolved' });
    });
    it('rejects when DNS returns empty', async () => {
      await expect(
        assertUrlIsSafe('http://ghost.example/', {
          resolve: async () => [],
        }),
      ).rejects.toMatchObject({ reason: 'dns-empty' });
    });
    it('rejects on DNS error', async () => {
      await expect(
        assertUrlIsSafe('http://broken.example/', {
          resolve: async () => {
            throw new Error('ENOTFOUND');
          },
        }),
      ).rejects.toMatchObject({ reason: 'dns-error' });
    });
  });

  describe('denyHosts glob', () => {
    it('rejects literal host match', async () => {
      await expect(
        assertUrlIsSafe('http://internal.api/', {
          resolve: publicResolve,
          denyHosts: ['internal.api'],
        }),
      ).rejects.toMatchObject({ reason: 'deny-host-glob' });
    });
    it('rejects wildcard suffix match', async () => {
      await expect(
        assertUrlIsSafe('http://sub.internal/', {
          resolve: publicResolve,
          denyHosts: ['*.internal'],
        }),
      ).rejects.toMatchObject({ reason: 'deny-host-glob' });
    });
    it('is case-insensitive', async () => {
      await expect(
        assertUrlIsSafe('http://FOO.EXAMPLE/', {
          resolve: publicResolve,
          denyHosts: ['foo.example'],
        }),
      ).rejects.toMatchObject({ reason: 'deny-host-glob' });
    });
    it('passes when no pattern matches', async () => {
      await expect(
        assertUrlIsSafe('http://good.example/', {
          resolve: publicResolve,
          denyHosts: ['*.internal', 'bad.com'],
        }),
      ).resolves.toBeTruthy();
    });
  });

  describe('malformed input', () => {
    it('rejects unparseable URL', async () => {
      await expect(
        assertUrlIsSafe('not a url', { resolve: publicResolve }),
      ).rejects.toMatchObject({ reason: 'invalid-url' });
    });
    it('rejects URL with no host', async () => {
      await expect(
        assertUrlIsSafe('http:///', { resolve: publicResolve }),
      ).rejects.toMatchObject({ reason: 'invalid-url' });
    });
  });

  describe('isPublicIp', () => {
    it('returns true for public IPv4', () => {
      expect(isPublicIp('8.8.8.8')).toBe(true);
      expect(isPublicIp('1.1.1.1')).toBe(true);
    });
    it('returns false for private + reserved ranges', () => {
      expect(isPublicIp('127.0.0.1')).toBe(false);
      expect(isPublicIp('10.0.0.1')).toBe(false);
      expect(isPublicIp('172.20.0.1')).toBe(false);
      expect(isPublicIp('192.168.1.1')).toBe(false);
      expect(isPublicIp('169.254.169.254')).toBe(false);
      expect(isPublicIp('0.0.0.0')).toBe(false);
      expect(isPublicIp('224.0.0.1')).toBe(false); // multicast
      expect(isPublicIp('240.0.0.1')).toBe(false); // reserved
    });
    it('returns false for non-IP strings', () => {
      expect(isPublicIp('not an ip')).toBe(false);
      expect(isPublicIp('')).toBe(false);
    });
  });

  describe('matchHostGlob', () => {
    it('matches exact', () => {
      expect(matchHostGlob('example.com', 'example.com')).toBe(true);
    });
    it('matches wildcard', () => {
      expect(matchHostGlob('foo.example.com', '*.example.com')).toBe(true);
      expect(matchHostGlob('a.b.example.com', '*.example.com')).toBe(true);
    });
    it('does not match across the boundary', () => {
      expect(matchHostGlob('example.com', '*.example.com')).toBe(false);
    });
    it('returns false for non-wildcard, non-equal', () => {
      expect(matchHostGlob('example.com', 'other.com')).toBe(false);
    });
  });
});
