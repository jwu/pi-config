import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

// Auto-format .ts files with prettier after edit/write tools
export default function (pi: ExtensionAPI) {
  pi.on('tool_result', async (event, ctx) => {
    if (event.isError) return;
    if (event.toolName !== 'edit' && event.toolName !== 'write') return;

    const input = event.input as { path?: string } | undefined;
    const filePath = input?.path;
    if (!filePath || !filePath.endsWith('.ts')) return;

    try {
      const result = await pi.exec('bun', ['prettier', '--write', filePath], {
        cwd: ctx.cwd,
        signal: ctx.signal,
      });

      if (result.code !== 0) {
        const message = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
        ctx.ui.notify(`Prettier failed for ${filePath}: ${message}`, 'error');
      }
    } catch (error) {
      if (ctx.signal?.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Prettier failed for ${filePath}: ${message}`, 'error');
    }
  });
}
