/** Tool: read-only system information (CPU, RAM, disk, uptime, Node version, running processes). */

import { z } from 'zod';
import os from 'os';
import type { Tool, ToolResult, ToolContext } from './types.js';

const SystemInfoInput = z.object({
  verbose: z.boolean().default(false).describe('Include detailed per-CPU and network info'),
});

type SystemInfoInputType = z.infer<typeof SystemInfoInput>;

function formatBytes(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(2)} MB`;
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(' ');
}

const systemInfoTool: Tool = {
  name: 'system_info',
  description:
    'Get system information: CPU load, RAM usage, disk info, process uptime, and OS details. ' +
    'Use for /status command or when checking system health.',
  parameters: SystemInfoInput,

  async execute(input: SystemInfoInputType, ctx: ToolContext): Promise<ToolResult> {
    const log = ctx.logger.child({ component: 'tools.system_info' });

    const cpus = os.cpus();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const memPct = ((usedMem / totalMem) * 100).toFixed(1);

    const loadAvg = os.loadavg(); // [1m, 5m, 15m]
    const uptimeSec = os.uptime();
    const processUptimeSec = process.uptime();

    const lines: string[] = [
      `**System Info**`,
      `OS: ${os.type()} ${os.release()} (${os.arch()})`,
      `Hostname: ${os.hostname()}`,
      `Uptime: ${formatUptime(uptimeSec)} (OS) | ${formatUptime(processUptimeSec)} (Jarvis)`,
      ``,
      `**Memory**`,
      `Used: ${formatBytes(usedMem)} / ${formatBytes(totalMem)} (${memPct}%)`,
      `Free: ${formatBytes(freeMem)}`,
      ``,
      `**CPU**`,
      `Cores: ${cpus.length} x ${cpus[0]?.model ?? 'unknown'}`,
      `Load avg: ${loadAvg[0]?.toFixed(2) ?? 'N/A'} (1m) / ${loadAvg[1]?.toFixed(2) ?? 'N/A'} (5m) / ${loadAvg[2]?.toFixed(2) ?? 'N/A'} (15m)`,
    ];

    if (input.verbose) {
      const networkInterfaces = os.networkInterfaces();
      const ifaces: string[] = [];
      for (const [name, addrs] of Object.entries(networkInterfaces)) {
        if (!addrs) continue;
        for (const addr of addrs) {
          if (!addr.internal) {
            ifaces.push(`  ${name}: ${addr.address} (${addr.family})`);
          }
        }
      }
      if (ifaces.length > 0) {
        lines.push(``, `**Network Interfaces**`, ...ifaces);
      }
    }

    const output = lines.join('\n');
    log.info({ memPct, cores: cpus.length }, 'system_info retrieved');

    return {
      ok: true,
      output,
      data: {
        totalMemMb: Math.round(totalMem / (1024 * 1024)),
        usedMemMb: Math.round(usedMem / (1024 * 1024)),
        memPct: parseFloat(memPct),
        cpuCount: cpus.length,
        uptimeSec,
        processUptimeSec,
      },
    };
  },
};

export default systemInfoTool;
